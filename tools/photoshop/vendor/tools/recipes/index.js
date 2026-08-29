import { bindRemoveBackground } from './remove-background.js';
import { bindEnhancePortrait } from './enhance-portrait.js';
import { bindPrepareForWeb } from './prepare-for-web.js';
import { bindExportSocialVariants } from './export-social-variants.js';
import { bindApplyColorGrade } from './apply-color-grade.js';
import { bindFrequencySeparation } from './frequency-separation.js';
import { bindBatchMockupReplace } from './batch-mockup-replace.js';
import { bindOrganizeLayers } from './organize-layers.js';
import { bindGradientFade } from './gradient-fade.js';
import { bindSkyBlend } from './sky-blend.js';
import { bindDodgeBurn } from './dodge-burn.js';
import { bindRemoveDistraction } from './remove-distraction.js';
import { bindSplitCarousel } from './split-carousel.js';
import { bindBatchWatermark } from './batch-watermark.js';
import { bindPassportPhoto } from './passport-photo.js';
import { bindCsvToCards } from './csv-to-cards.js';
export function createRecipeTools(connection) {
    return [
        bindRemoveBackground(connection),
        bindEnhancePortrait(connection),
        bindPrepareForWeb(connection),
        bindExportSocialVariants(connection),
        bindApplyColorGrade(connection),
        bindFrequencySeparation(connection),
        bindBatchMockupReplace(connection),
        bindOrganizeLayers(connection),
        bindGradientFade(connection),
        bindSkyBlend(connection),
        bindDodgeBurn(connection),
        bindRemoveDistraction(connection),
        bindSplitCarousel(connection),
        bindBatchWatermark(connection),
        bindPassportPhoto(connection),
        bindCsvToCards(connection),
    ];
}
export const PHOTOSHOP_RECIPE_TOOL_NAMES = [
    'recipe_remove_background',
    'recipe_enhance_portrait',
    'recipe_prepare_for_web',
    'recipe_export_social_variants',
    'recipe_apply_color_grade',
    'recipe_frequency_separation',
    'recipe_batch_mockup_replace',
    'recipe_organize_layers',
    'recipe_gradient_fade',
    'recipe_sky_blend',
    'recipe_dodge_burn',
    'recipe_remove_distraction',
    'recipe_split_carousel',
    'recipe_batch_watermark',
    'recipe_passport_photo',
    'recipe_csv_to_cards',
];
