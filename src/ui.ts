import { XMLParser } from "fast-xml-parser";

import { AdbClient, ActionableError } from "./adb.js";

export interface ElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenElement {
	type: string;
	text?: string;
	label?: string;
	identifier?: string;
	focused?: boolean;
	clickable?: boolean;
	enabled?: boolean;
	checked?: boolean;
	rect: ElementRect;
}

export interface ElementSelector {
	text?: string;
	textContains?: string;
	resourceId?: string;
	contentDesc?: string;
	contentDescExact?: string;
	className?: string;
	textRegex?: string;
	clickable?: boolean;
	enabled?: boolean;
	focused?: boolean;
	checked?: boolean;
	nearText?: string;
	maxDistance?: number;
}

interface UiNode {
	node?: UiNode | UiNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	clickable?: string;
	enabled?: string;
	checkable?: string;
	checked?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

const parseBounds = (bounds: string | undefined): ElementRect => {
	const m = String(bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
	if (!m) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}
	const [, left, top, right, bottom] = m.map(Number);
	return { x: left, y: top, width: right - left, height: bottom - top };
};

const collectElements = (node: UiNode, out: ScreenElement[]): void => {
	if (node.node) {
		const children = Array.isArray(node.node) ? node.node : [node.node];
		for (const child of children) {
			collectElements(child, out);
		}
	}

	const interesting =
		node.text || node["content-desc"] || node.hint || node["resource-id"] || node.checkable === "true" || node.clickable === "true";
	if (!interesting) {
		return;
	}

	const rect = parseBounds(node.bounds);
	if (rect.width <= 0 || rect.height <= 0) {
		return;
	}

	const element: ScreenElement = {
		type: node.class || "text",
		rect,
	};
	if (node.text) {
		element.text = node.text;
	}
	const label = node["content-desc"] || node.hint;
	if (label) {
		element.label = label;
	}
	const resourceId = node["resource-id"];
	if (resourceId) {
		element.identifier = resourceId;
	}
	if (node.focused === "true") {
		element.focused = true;
	}
	if (node.clickable === "true") {
		element.clickable = true;
	}
	if (node.enabled === "true") {
		element.enabled = true;
	}
	if (node.checked === "true") {
		element.checked = true;
	}

	out.push(element);
};

export class UiInspector {

	constructor(private adb: AdbClient) {
	}

	private dumpXml(deviceId: string): string {
		for (let tries = 0; tries < 10; tries++) {
			const dump = this.adb.adb(deviceId, "exec-out", "uiautomator", "dump", "/dev/tty").toString();
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				continue;
			}
			const xmlStart = dump.indexOf("<?xml");
			if (xmlStart >= 0) {
				return dump.substring(xmlStart);
			}
		}
		throw new ActionableError(
			"Failed to dump UI hierarchy. The screen may be in a secure view (password field, DRM content) -- try android_take_screenshot instead."
		);
	}

	public getElements(deviceId: string): ScreenElement[] {
		const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
		const parsed = parser.parse(this.dumpXml(deviceId)) as { hierarchy?: { node?: UiNode } };
		const root = parsed.hierarchy?.node;
		if (!root) {
			return [];
		}
		const elements: ScreenElement[] = [];
		collectElements(root, elements);
		return elements;
	}

	/** Expand a short resource id ("btn_login") to full form ("com.app:id/btn_login") using the foreground app. */
	private resolveResourceId(deviceId: string, resourceId: string): string {
		if (resourceId.includes("/") || resourceId.includes(":")) {
			return resourceId;
		}
		const pkg = this.adb.getCurrentApp(deviceId).packageName;
		if (pkg !== "unknown") {
			return `${pkg}:id/${resourceId}`;
		}
		return resourceId;
	}

	public describeSelector(selector: ElementSelector): string {
		return JSON.stringify(
			Object.fromEntries(Object.entries(selector).filter(([, v]) => v !== undefined && v !== ""))
		);
	}

	public hasAnySelector(selector: ElementSelector): boolean {
		return Object.entries(selector).some(([key, value]) => key !== "maxDistance" && value !== undefined && value !== "");
	}

	public findElements(deviceId: string, selector: ElementSelector): ScreenElement[] {
		const resolvedId = selector.resourceId ? this.resolveResourceId(deviceId, selector.resourceId) : undefined;
		let textPattern: RegExp | undefined;
		if (selector.textRegex !== undefined) {
			try {
				textPattern = new RegExp(selector.textRegex);
			} catch {
				throw new ActionableError(`Invalid textRegex: ${selector.textRegex}`);
			}
		}
		const elements = this.getElements(deviceId);
		const nearTargets = selector.nearText === undefined
			? []
			: elements.filter(el => el.text?.toLowerCase().includes(selector.nearText!.toLowerCase()));

		return elements.filter(el => {
			if (selector.text !== undefined && el.text !== selector.text) {
				return false;
			}
			if (selector.textContains !== undefined) {
				if (!el.text || !el.text.toLowerCase().includes(selector.textContains.toLowerCase())) {
					return false;
				}
			}
			if (textPattern !== undefined && (!el.text || !textPattern.test(el.text))) {
				return false;
			}
			if (resolvedId !== undefined) {
				const matchesFull = el.identifier === resolvedId;
				const matchesSuffix = el.identifier?.endsWith(`:id/${selector.resourceId}`) ?? false;
				if (!matchesFull && !matchesSuffix) {
					return false;
				}
			}
			if (selector.contentDesc !== undefined) {
				if (!el.label || !el.label.toLowerCase().includes(selector.contentDesc.toLowerCase())) {
					return false;
				}
			}
			if (selector.contentDescExact !== undefined && el.label !== selector.contentDescExact) {
				return false;
			}
			if (selector.className !== undefined) {
				if (el.type !== selector.className && !el.type.endsWith(`.${selector.className}`)) {
					return false;
				}
			}
			if (selector.clickable !== undefined && Boolean(el.clickable) !== selector.clickable) {
				return false;
			}
			if (selector.enabled !== undefined && Boolean(el.enabled) !== selector.enabled) {
				return false;
			}
			if (selector.focused !== undefined && Boolean(el.focused) !== selector.focused) {
				return false;
			}
			if (selector.checked !== undefined && Boolean(el.checked) !== selector.checked) {
				return false;
			}
			if (selector.nearText !== undefined) {
				const maxDistance = selector.maxDistance ?? 200;
				const center = elementCenter(el);
				const isNear = nearTargets.some(target => {
					if (target === el) return false;
					const targetCenter = elementCenter(target);
					return Math.hypot(center.x - targetCenter.x, center.y - targetCenter.y) <= maxDistance;
				});
				if (!isNear) return false;
			}
			return true;
		});
	}

	public async waitForElement(
		deviceId: string,
		selector: ElementSelector,
		timeoutMs: number,
		index = 0
	): Promise<ScreenElement | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const matches = this.findElements(deviceId, selector);
			if (matches.length > index) {
				return matches[index];
			}
			if (Date.now() >= deadline) {
				return null;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}

	public async waitForNoElement(deviceId: string, selector: ElementSelector, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.findElements(deviceId, selector).length === 0) {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
}

export const elementCenter = (el: ScreenElement): { x: number; y: number } => {
	return {
		x: el.rect.x + Math.floor(el.rect.width / 2),
		y: el.rect.y + Math.floor(el.rect.height / 2),
	};
};
