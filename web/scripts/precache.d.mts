import type { Plugin } from "vite";

export function listPrecache(dir: string): string[];
export function precacheUrls(files: string[]): string[];
export function buildId(dir: string, files: string[]): string;
export function injectBuild(source: string, id: string, urls: string[]): string;
export function swPrecachePlugin(): Plugin;
