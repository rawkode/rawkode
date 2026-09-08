import {invoke} from '@tauri-apps/api/core';

export interface LoadedDay { day: string; token: string; revision: number; sequence?: number; dirty?: boolean; snapshot: number[] | null; legacy: number[] | null }
export interface Settings { displayName: string; showMenuBarItem: boolean }
export interface SaveReceipt { revision: number; sequence: number }
export const loadDay = (day: string) => invoke<LoadedDay>('load_day', {day});
export const getSettings = () => invoke<Settings>('get_settings');
export const saveSettings = (settings: Settings) => invoke<Settings>('save_settings', {settings});
export const writeSnapshot = (request: {day:string; token:string; sequence:number; baseRevision:number; snapshot:number[]}) =>
  invoke<SaveReceipt>('save_day', {request});
export const finishQuit = (token: string | null, sequence: number) => invoke('finish_quit', {token, sequence});

export async function previewKey(kind: string, source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`diagram-v1\0${kind}\0${source}`));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,'0')).join('');
}
export async function loadPreview(kind: string, source: string) {
  return invoke<string | null>('load_preview', {key: await previewKey(kind, source)});
}
export async function storePreview(kind: string, source: string, dataUrl?: string) {
  if (dataUrl) await invoke('save_preview', {key: await previewKey(kind, source), dataUrl});
}
