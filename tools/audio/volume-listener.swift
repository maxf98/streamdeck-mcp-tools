// volume-listener.swift — event-driven macOS audio watcher AND controller.
//
// Compiled on first run by server.mjs and spawned as a long-lived child. It
// registers Core Audio property listeners (NO polling) and prints one JSON line
// per change to stdout. Line shapes, distinguished by the "t" tag:
//
//     {"t":"o","level":42,"muted":false}              default OUTPUT vol / mute
//     {"t":"i","level":70,"muted":true}               default INPUT  vol / mute
//     {"t":"d","output":"<uid>","input":"<uid>",       defaults + FULL inventory,
//      "devices":[{"id":74,"uid":"…","name":"…",        each device carrying its
//        "canInput":true,"canOutput":false,             own live volume/mute and
//        "output":{"level":35,"muted":false,"settable":true},   whether volume is
//        "input":{"level":0,"muted":false,"settable":false}}]}  settable per scope
//
// All shapes are printed once on startup so the consumer has full state before
// the first change. Listeners fire the instant ANY device's volume/mute toggles,
// the default in/out device switches, or a device is (un)plugged — zero latency,
// zero idle CPU. When the default device changes we re-point the default-tracking
// listeners; when the device list changes we rebind the per-device listeners.
//
// It ALSO accepts commands on stdin (one per line) to drive Core Audio directly —
// no `osascript` subprocess per change, so a slider drag updates at full input
// rate. Setting via Core Audio fires our own listeners, so the applied value is
// echoed back on stdout like any other change. Commands (UIDs go LAST because
// Core Audio UIDs can contain spaces):
//
//     ov <0-100>            set DEFAULT output volume     om <0|1>  default out mute
//     iv <0-100>            set DEFAULT input  volume     im <0|1>  default in  mute
//     od <uid…>             set default output device by UID
//     id <uid…>             set default input  device by UID
//     sv <o|i> <0-100> <uid…>   set a SPECIFIC device's volume on a scope
//     sm <o|i> <0|1>   <uid…>   set a SPECIFIC device's mute   on a scope
//     dump                  re-emit all lines (forced, ignores change-coalescing)

import CoreAudio
import AudioToolbox
import Foundation

let system = AudioObjectID(kAudioObjectSystemObject)
let outScope = kAudioDevicePropertyScopeOutput
let inScope = kAudioDevicePropertyScopeInput

// ── Core Audio property helpers ───────────────────────────────────────────────

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var dev = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &dev)
    return dev
}

func setDefaultDevice(_ selector: AudioObjectPropertySelector, _ dev: AudioDeviceID) {
    var d = dev
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    AudioObjectSetPropertyData(system, &addr, 0, nil, size, &d)
}

func volAddr(_ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func muteAddr(_ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func readVolume(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    guard dev != 0 else { return 0 }
    var vol = Float(0)
    var size = UInt32(MemoryLayout<Float>.size)
    var addr = volAddr(scope)
    let status = AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &vol)
    return status == noErr ? Int((vol * 100).rounded()) : 0
}

func readMuted(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Bool {
    guard dev != 0 else { return false }
    var muted = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = muteAddr(scope)
    let status = AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &muted)
    return status == noErr && muted != 0
}

/// Whether this device exposes a *settable* virtual main volume on the scope.
func volumeSettable(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Bool {
    guard dev != 0 else { return false }
    var addr = volAddr(scope)
    guard AudioObjectHasProperty(dev, &addr) else { return false }
    var settable = DarwinBoolean(false)
    return AudioObjectIsPropertySettable(dev, &addr, &settable) == noErr && settable.boolValue
}

func setVolume(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope, _ level: Int) {
    guard dev != 0 else { return }
    var vol = Float(max(0, min(100, level))) / 100.0
    let size = UInt32(MemoryLayout<Float>.size)
    var addr = volAddr(scope)
    AudioObjectSetPropertyData(dev, &addr, 0, nil, size, &vol)
}

func setMuted(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope, _ muted: Bool) {
    guard dev != 0 else { return }
    var val = UInt32(muted ? 1 : 0)
    let size = UInt32(MemoryLayout<UInt32>.size)
    var addr = muteAddr(scope)
    AudioObjectSetPropertyData(dev, &addr, 0, nil, size, &val)
}

func stringProp(_ dev: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var cf: CFString? = nil
    let status = withUnsafeMutablePointer(to: &cf) { ptr -> OSStatus in
        AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, ptr)
    }
    if status == noErr, let s = cf as String? { return s }
    return ""
}

/// Channel count on a scope — >0 means the device can capture (input) or play
/// (output) on that scope.
func channelCount(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    var count = 0
    for buf in abl { count += Int(buf.mNumberChannels) }
    return count
}

func allDevices() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func deviceForUID(_ uid: String) -> AudioDeviceID {
    for dev in allDevices() where stringProp(dev, kAudioDevicePropertyDeviceUID) == uid { return dev }
    return 0
}

// ── State + change-coalesced emit ─────────────────────────────────────────────

var currentOutput = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
var currentInput = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)

var lastOut = ""
var lastIn = ""
var lastDevices = ""

func emitOutput(force: Bool = false) {
    let line = "{\"t\":\"o\",\"level\":\(readVolume(currentOutput, outScope)),\"muted\":\(readMuted(currentOutput, outScope))}"
    if !force && line == lastOut { return }
    lastOut = line
    print(line); fflush(stdout)
}

func emitInput(force: Bool = false) {
    let line = "{\"t\":\"i\",\"level\":\(readVolume(currentInput, inScope)),\"muted\":\(readMuted(currentInput, inScope))}"
    if !force && line == lastIn { return }
    lastIn = line
    print(line); fflush(stdout)
}

func emitDevices(force: Bool = false) {
    var list: [[String: Any]] = []
    for dev in allDevices() {
        let inCh = channelCount(dev, inScope)
        let outCh = channelCount(dev, outScope)
        if inCh == 0 && outCh == 0 { continue } // skip non-audio aggregates
        var entry: [String: Any] = [
            "id": Int(dev),
            "uid": stringProp(dev, kAudioDevicePropertyDeviceUID),
            "name": stringProp(dev, kAudioObjectPropertyName),
            "canInput": inCh > 0,
            "canOutput": outCh > 0,
        ]
        if outCh > 0 {
            entry["output"] = [
                "level": readVolume(dev, outScope),
                "muted": readMuted(dev, outScope),
                "settable": volumeSettable(dev, outScope),
            ]
        }
        if inCh > 0 {
            entry["input"] = [
                "level": readVolume(dev, inScope),
                "muted": readMuted(dev, inScope),
                "settable": volumeSettable(dev, inScope),
            ]
        }
        list.append(entry)
    }
    let payload: [String: Any] = [
        "t": "d",
        "output": stringProp(currentOutput, kAudioDevicePropertyDeviceUID),
        "input": stringProp(currentInput, kAudioDevicePropertyDeviceUID),
        "devices": list,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    if !force && line == lastDevices { return }
    lastDevices = line
    print(line); fflush(stdout)
}

// ── Listener blocks ───────────────────────────────────────────────────────────

let outVolMuteListener: AudioObjectPropertyListenerBlock = { _, _ in emitOutput() }
let inVolMuteListener: AudioObjectPropertyListenerBlock = { _, _ in emitInput() }
// Any device's volume/mute changed → re-emit the full inventory (coalesced).
let deviceVolMuteListener: AudioObjectPropertyListenerBlock = { _, _ in emitDevices() }

func bindDeviceListeners(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope,
                         _ block: @escaping AudioObjectPropertyListenerBlock) {
    guard dev != 0 else { return }
    var v = volAddr(scope), m = muteAddr(scope)
    AudioObjectAddPropertyListenerBlock(dev, &v, DispatchQueue.main, block)
    AudioObjectAddPropertyListenerBlock(dev, &m, DispatchQueue.main, block)
}
func unbindDeviceListeners(_ dev: AudioDeviceID, _ scope: AudioObjectPropertyScope,
                           _ block: @escaping AudioObjectPropertyListenerBlock) {
    guard dev != 0 else { return }
    var v = volAddr(scope), m = muteAddr(scope)
    AudioObjectRemovePropertyListenerBlock(dev, &v, DispatchQueue.main, block)
    AudioObjectRemovePropertyListenerBlock(dev, &m, DispatchQueue.main, block)
}

// Per-device listeners (every device, every capable scope) so ANY device's
// volume/mute change pushes an updated inventory. Tracked so we can rebind when
// devices come and go.
var boundDeviceProps: [(AudioDeviceID, AudioObjectPropertyScope)] = []
func rebindDeviceListeners() {
    for (dev, scope) in boundDeviceProps {
        unbindDeviceListeners(dev, scope, deviceVolMuteListener)
    }
    boundDeviceProps.removeAll()
    for dev in allDevices() {
        for scope in [outScope, inScope] where channelCount(dev, scope) > 0 {
            bindDeviceListeners(dev, scope, deviceVolMuteListener)
            boundDeviceProps.append((dev, scope))
        }
    }
}

// ── Default-device tracking ───────────────────────────────────────────────────

func refreshDefaultOutput() {
    let next = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
    if next != currentOutput {
        unbindDeviceListeners(currentOutput, outScope, outVolMuteListener)
        currentOutput = next
        bindDeviceListeners(currentOutput, outScope, outVolMuteListener)
    }
    emitOutput(); emitDevices()
}
func refreshDefaultInput() {
    let next = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
    if next != currentInput {
        unbindDeviceListeners(currentInput, inScope, inVolMuteListener)
        currentInput = next
        bindDeviceListeners(currentInput, inScope, inVolMuteListener)
    }
    emitInput(); emitDevices()
}

let defaultOutListener: AudioObjectPropertyListenerBlock = { _, _ in refreshDefaultOutput() }
let defaultInListener: AudioObjectPropertyListenerBlock = { _, _ in refreshDefaultInput() }
let deviceListListener: AudioObjectPropertyListenerBlock = { _, _ in
    rebindDeviceListeners()           // a device came/went — refresh per-device hooks
    refreshDefaultOutput(); refreshDefaultInput()
}

func addSystemListener(_ selector: AudioObjectPropertySelector,
                       _ block: @escaping AudioObjectPropertyListenerBlock) {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(system, &addr, DispatchQueue.main, block)
}

// ── Wire up ───────────────────────────────────────────────────────────────────

bindDeviceListeners(currentOutput, outScope, outVolMuteListener)
bindDeviceListeners(currentInput, inScope, inVolMuteListener)
rebindDeviceListeners()
addSystemListener(kAudioHardwarePropertyDefaultOutputDevice, defaultOutListener)
addSystemListener(kAudioHardwarePropertyDefaultInputDevice, defaultInListener)
addSystemListener(kAudioHardwarePropertyDevices, deviceListListener)

emitOutput(force: true)
emitInput(force: true)
emitDevices(force: true)

// ── Stdin command loop ────────────────────────────────────────────────────────

func scopeFor(_ tok: String) -> AudioObjectPropertyScope? {
    tok == "o" ? outScope : tok == "i" ? inScope : nil
}

var stdinBuf = Data()
func handleCommand(_ line: String) {
    // Tokenize only the leading fixed-arity tokens; UIDs (which can contain
    // spaces) are always the trailing remainder.
    func split1(_ s: String) -> (String, String) {
        guard let sp = s.firstIndex(of: " ") else { return (s, "") }
        return (String(s[s.startIndex..<sp]),
                String(s[s.index(after: sp)...]).trimmingCharacters(in: .whitespaces))
    }
    let (cmd, rest1) = split1(line)
    switch cmd {
    case "ov": if let n = Int(rest1) { setVolume(currentOutput, outScope, n) }
    case "om": setMuted(currentOutput, outScope, rest1 == "1" || rest1 == "true")
    case "iv": if let n = Int(rest1) { setVolume(currentInput, inScope, n) }
    case "im": setMuted(currentInput, inScope, rest1 == "1" || rest1 == "true")
    case "od": let d = deviceForUID(rest1); if d != 0 { setDefaultDevice(kAudioHardwarePropertyDefaultOutputDevice, d) }
    case "id": let d = deviceForUID(rest1); if d != 0 { setDefaultDevice(kAudioHardwarePropertyDefaultInputDevice, d) }
    case "sv": // sv <o|i> <level> <uid…>
        let (scopeTok, rest2) = split1(rest1)
        let (levelTok, uid) = split1(rest2)
        if let scope = scopeFor(scopeTok), let n = Int(levelTok), !uid.isEmpty {
            let d = deviceForUID(uid); if d != 0 { setVolume(d, scope, n) }
        }
    case "sm": // sm <o|i> <0|1> <uid…>
        let (scopeTok, rest2) = split1(rest1)
        let (muteTok, uid) = split1(rest2)
        if let scope = scopeFor(scopeTok), !uid.isEmpty {
            let d = deviceForUID(uid); if d != 0 { setMuted(d, scope, muteTok == "1" || muteTok == "true") }
        }
    case "dump": emitOutput(force: true); emitInput(force: true); emitDevices(force: true)
    default: break
    }
}

let stdinSource = DispatchSource.makeReadSource(
    fileDescriptor: FileHandle.standardInput.fileDescriptor, queue: .main)
stdinSource.setEventHandler {
    let data = FileHandle.standardInput.availableData
    if data.isEmpty { exit(0) }  // EOF — parent gone
    stdinBuf.append(data)
    while let nl = stdinBuf.firstIndex(of: 0x0A) {  // '\n'
        let lineData = stdinBuf.subdata(in: stdinBuf.startIndex..<nl)
        stdinBuf.removeSubrange(stdinBuf.startIndex...nl)
        if let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespaces),
           !line.isEmpty {
            handleCommand(line)
        }
    }
}
stdinSource.resume()

CFRunLoopRun()
