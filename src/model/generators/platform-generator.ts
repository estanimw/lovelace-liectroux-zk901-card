import {
    CalibrationPoint,
    IconTemplate,
    MapModeConfig,
    PlatformTemplate,
    TileFromAttributeTemplate,
    TileFromSensorTemplate,
    VariablesStorage,
} from "../../types/types";
import { SelectionType } from "../map_mode/selection-type";

export class PlatformGenerator {
    public static DEFAULT_PLATFORM = "default";

    // Generic rendering base. ZK901 actions will come from our HA integration;
    // no vendor command templates are bundled in this fork.
    private static DEFAULT_TEMPLATE: PlatformTemplate = {
        map_modes: { default_templates: [], templates: {} },
    };

    public static getPlatformsWithDefaultCalibration(): string[] {
        return [];
    }

    public static getPlatforms(): string[] {
        return [this.DEFAULT_PLATFORM];
    }

    public static getPlatformName(platform: string | undefined): string {
        return platform ?? this.DEFAULT_PLATFORM;
    }

    public static getPlatformsDocumentationUrl(_platform: string): string {
        return "https://github.com/estanimw/lovelace-liectroux-zk901-card/blob/master/docs/INSTALLATION.md";
    }

    public static isValidModeTemplate(platform: string, template?: string): boolean {
        return (
            template !== undefined &&
            Object.keys(this.getPlatformTemplate(platform).map_modes.templates).includes(template)
        );
    }

    public static getModeTemplate(platform: string, template: string): MapModeConfig {
        return this.getPlatformTemplate(platform).map_modes.templates[template];
    }

    public static generateDefaultModes(platform: string): MapModeConfig[] {
        return this.getPlatformTemplate(platform).map_modes.default_templates.map(dt => ({ template: dt }));
    }

    public static getTilesFromAttributesTemplates(platform: string): TileFromAttributeTemplate[] {
        return this.getPlatformTemplate(platform).tiles?.from_attributes ?? [];
    }

    public static getTilesFromSensorsTemplates(platform: string): TileFromSensorTemplate[] {
        return this.getPlatformTemplate(platform).tiles?.from_sensors ?? [];
    }

    public static getIconsTemplates(platform: string): IconTemplate[] {
        return this.getPlatformTemplate(platform).icons ?? [];
    }

    public static getRoomsTemplate(platform: string): string | undefined {
        const platformTemplate = this.getPlatformTemplate(platform);
        for (const templateName in platformTemplate.map_modes.templates) {
            const template = platformTemplate.map_modes.templates[templateName];
            if (template.selection_type === SelectionType[SelectionType.ROOM]) {
                return templateName;
            }
        }
        return undefined;
    }

    public static getCalibration(platform: string | undefined): CalibrationPoint[] | undefined {
        return this.getPlatformTemplate(PlatformGenerator.getPlatformName(platform)).calibration_points;
    }

    public static getVariables(platform: string | undefined): VariablesStorage | undefined {
        return this.getPlatformTemplate(PlatformGenerator.getPlatformName(platform)).internal_variables;
    }

    private static getPlatformTemplate(_platform: string): PlatformTemplate {
        return this.DEFAULT_TEMPLATE;
    }
}
