import { css, CSSResultGroup, html, TemplateResult } from "lit";
import { conditional } from "../utils";
import { customElement, property, query } from "lit/decorators";
import { RootlessLitElement } from "./rootless-lit-element";
import { HaDropdown } from "../types/fixes";

interface DropdownEntry {
    icon: string;
    name: string;
    tooltip?: string;
    disabled?: boolean;
}

@customElement("zk901-community-dropdown-menu")
export class DropdownMenu<T extends DropdownEntry> extends RootlessLitElement {

    @property({ attribute: false })
    private values!: T[];

    @property({ attribute: false })
    private currentIndex!: number;

    @property({ attribute: false })
    private setValue!: (_: number) => void;

    @property({ attribute: false })
    private renderNameCollapsed!: boolean;

    @property({ attribute: false })
    private additionalClasses: string[] = [];

    @property({ attribute: false })
    private disabled = false;

    @query(".dropdown-menu")
    private menu: HaDropdown | undefined;

    public render(): TemplateResult {
        const currentValue = this.values[this.currentIndex];
        return html`
            <ha-dropdown distance="-50" class="dropdown-menu ${this.additionalClasses.join(" ")}" fixed="true" activatable>
                <button type="button" class="dropdown-menu-button clickable" slot="trigger"
                    ?disabled=${this.disabled} aria-label=${currentValue.tooltip ?? currentValue.name}>
                    <span class="dropdown-menu-button-button"><ha-icon icon="${currentValue.icon}" class="dropdown-icon"></ha-icon></span>
                    ${conditional(this.renderNameCollapsed, () => html`<span class="dropdown-menu-button-text">${currentValue.name}</span>`)}
                </button>
                ${this.values.map(
                    (mode, index) => html`
                        <div class="dropdown-list-item" role="option" tabindex="0" aria-label=${mode.name} aria-disabled=${mode.disabled ? "true" : "false"} aria-selected=${this.currentIndex === index ? "true" : "false"} @keydown=${(e: KeyboardEvent) => this.optionKeyDown(e, index)}
                             ?activated="${this.currentIndex === index}"
                             @click="${(): void => this.internalClick(index)}"
                             title="${mode.tooltip ?? ''}"
                        >
                            <div
                                class="dropdown-menu-entry clickable ${this.currentIndex === index ? "selected" : ""}">
                                <div
                                    class="dropdown-menu-entry-button-wrapper ${index === 0
                                        ? "first"
                                        : ""} ${index === this.values.length - 1 ? "last" : ""} ${this.currentIndex === index
                                        ? "selected"
                                        : ""}">
                                    <paper-button
                                        class="dropdown-menu-entry-button ${this.currentIndex === index ? "selected" : ""}">
                                        <ha-icon icon="${mode.icon}"></ha-icon>
                                    </paper-button>
                                </div>
                                <div class="dropdown-menu-entry-text">${mode.name}</div>
                            </div>
                        </div>`,
                )}
            </ha-dropdown>
        `;
    }

    private optionKeyDown(event: KeyboardEvent, index: number): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); this.internalClick(index); return;
        }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const options = Array.from(this.querySelectorAll<HTMLElement>('[role="option"]'));
        let next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
        for (let count = 0; count < options.length && this.values[next]?.disabled; count++) next = (next + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
        options[next]?.focus();
    }

    private internalClick(value: number): void {
        if (this.disabled || this.values[value]?.disabled) return;
        this.menu?.hideMenu();
        this.setValue(value);
    }

    public static get styles(): CSSResultGroup {
        return css`
          .dropdown-menu {
              --ha-space-1: 0;
              --wa-border-style: none;
              --wa-border-radius-s: 25px;
              --wa-border-radius-m: 25px;
              --wa-border-radius-l: 25px;
              --mdc-menu-item-height: 50px;
              --mdc-theme-primary: transparent;
              --mdc-list-vertical-padding: 0px;
              --mdc-list-side-padding: 0px;
              --mdc-shape-medium: var(--map-card-internal-big-radius);
              --mdc-ripple-color: transparent;
          }

          .dropdown-menu-button {
              border: 0; padding: 0; font: inherit; color: inherit; background: transparent; cursor: pointer;
            display: inline-flex;
          }

          .dropdown-list-item:host:host {
            flex-grow: 1;
          }

          .dropdown-menu-button-button {
            width: 50px;
            height: 50px;
            border-radius: var(--map-card-internal-big-radius);
            display: flex;
            justify-content: center;
            background-color: var(--map-card-internal-primary-color);
            align-items: center;
          }

          .dropdown-menu-button-text {
            display: inline-flex;
            line-height: 50px;
            background-color: transparent;
            padding-left: 10px;
            padding-right: 15px;
          }

          .dropdown-menu-entry {
            display: inline-flex;
            width: 100%;
          }

          .dropdown-menu-entry.selected {
            border-radius: var(--map-card-internal-big-radius);
            background-color: var(--map-card-internal-primary-color);
            color: var(--map-card-internal-primary-text-color);
          }

          .dropdown-menu-entry-button-wrapper.first:not(.selected) {
            border-top-left-radius: var(--map-card-internal-big-radius);
            border-top-right-radius: var(--map-card-internal-big-radius);
          }

          .dropdown-menu-entry-button-wrapper.last:not(.selected) {
            border-bottom-left-radius: var(--map-card-internal-big-radius);
            border-bottom-right-radius: var(--map-card-internal-big-radius);
          }

          .dropdown-menu-entry-button.selected {
            border-start-start-radius: var(--map-card-internal-big-radius);
            border-end-start-radius: var(--map-card-internal-big-radius);
            background-color: var(--map-card-internal-primary-color);
            color: var(--map-card-internal-primary-text-color);
          }

          .dropdown-menu-entry-button-wrapper {
            background-color: var(--map-card-internal-secondary-color);
            color: var(--map-card-internal-secondary-text-color);
            overflow: hidden;
          }

          .dropdown-menu-entry-button {
            width: 50px;
            height: 50px;
            display: flex;
            justify-content: center;
            align-items: center;
            background-color: var(--map-card-internal-secondary-color);
            color: var(--map-card-internal-secondary-text-color);
          }

          .dropdown-menu-entry-text {
            display: inline-flex;
            line-height: 50px;
            background-color: transparent;
            padding-left: 10px;
            padding-right: 15px;
          }
        `;
    }
}