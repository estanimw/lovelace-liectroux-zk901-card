/* eslint-disable @typescript-eslint/no-unused-vars */
import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators";
import { fireEvent, LovelaceCardEditor, type HomeAssistant } from "custom-card-helpers";

import { CARD_CUSTOM_ELEMENT_NAME, EDITOR_CUSTOM_ELEMENT_NAME, INTEGRATION_DOMAIN } from "./const";
import type { HomeAssistantFixed } from "./types/fixes";

interface CardConfig {
    type: string;
    entity: string;
    title?: string;
    [key: string]: unknown;
}

@customElement(EDITOR_CUSTOM_ELEMENT_NAME)
export class LiectrouxZK901MapCardEditor extends LitElement implements LovelaceCardEditor {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private _config?: CardConfig;

    setConfig(config: CardConfig): void {
        this._config = { ...config };
    }

    protected render() {
        const entityRegistry = (this.hass as unknown as HomeAssistantFixed | undefined)?.entities ?? {};
        const entities = Object.values(entityRegistry).filter(
            entry => entry.platform === INTEGRATION_DOMAIN && entry.entity_id.startsWith("vacuum."),
        );
        const entity = this._config?.entity ?? "";
        const selectedExists = entities.some(entry => entry.entity_id === entity);

        return html`
            <div class="editor">
                <label for="entity">Aspiradora Liectroux ZK901</label>
                <select id="entity" .value=${entity} @change=${this._entityChanged}>
                    <option value="" disabled>Seleccioná una aspiradora</option>
                    ${entities.map(
                        entry => html` <option value=${entry.entity_id}>${entry.name ?? entry.entity_id}</option> `,
                    )}
                    ${entity && !selectedExists
                        ? html` <option value=${entity} disabled>${entity} (no es una ZK901 disponible)</option> `
                        : ""}
                </select>
                <label for="title">Título (opcional)</label>
                <input id="title" type="text" .value=${this._config?.title ?? ""} @input=${this._titleChanged} />
                ${entities.length === 0
                    ? html` <p class="empty">No hay aspiradoras Liectroux ZK901 disponibles.</p> `
                    : ""}
            </div>
        `;
    }

    private _entityChanged = (event: Event): void => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        this._setConfig({ entity: value });
    };

    private _titleChanged = (event: Event): void => {
        const value = (event.currentTarget as HTMLInputElement).value;
        this._setConfig({ title: value || undefined });
    };

    private _setConfig(patch: Partial<CardConfig>): void {
        const config: CardConfig = {
            ...(this._config ?? { type: CARD_CUSTOM_ELEMENT_NAME, entity: "" }),
            ...patch,
        };
        this._config = config;
        fireEvent(this, "config-changed", { config });
    }

    static styles = css`
        :host {
            display: block;
        }
        .editor {
            display: grid;
            gap: 10px;
            padding: 8px 0;
        }
        label {
            color: var(--primary-text-color);
            font-weight: 600;
        }
        select,
        input {
            box-sizing: border-box;
            width: 100%;
            min-height: 42px;
            padding: 8px 10px;
            color: var(--primary-text-color);
            background: var(--card-background-color, var(--ha-card-background, white));
            border: 1px solid var(--divider-color);
            border-radius: 8px;
            font: inherit;
        }
        p {
            margin: 0;
            color: var(--secondary-text-color);
            line-height: 1.45;
        }
        .empty {
            color: var(--error-color, #b3261e);
        }
        :focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
        }
    `;
}
