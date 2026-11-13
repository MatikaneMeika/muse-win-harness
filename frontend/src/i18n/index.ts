import { useMwhState } from '../services/useMwhState';
import { en } from './locales/en';
import { ja } from './locales/ja';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';
import type { SupportedLocale, TranslationParams } from './types';

export type { SupportedLocale, TranslationParams } from './types';

const LOCALE_MAP: Record<SupportedLocale, Record<string, string>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  en,
};

export function normalizeLocale(raw?: string | null): SupportedLocale {
  const s = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return 'en';
  if (s === 'zh-tw' || s === 'zh-hk' || s === 'zh-mo' || s.startsWith('zh-hant')) {
    return 'zh-TW';
  }
  if (s.startsWith('zh')) {
    return 'zh-CN';
  }
  if (s.startsWith('ja')) {
    return 'ja';
  }
  return 'en';
}

export function detectInitialLocale(): SupportedLocale {
  if (typeof navigator !== 'undefined') {
    const primary = navigator.language || (Array.isArray(navigator.languages) ? navigator.languages[0] : '');
    return normalizeLocale(primary);
  }
  return 'en';
}

export function translate(locale: SupportedLocale, key: string, params?: TranslationParams): string {
  const dict = LOCALE_MAP[locale] || en;
  let text = dict[key] ?? en[key] ?? zhCN[key] ?? key;
  if (params) {
    for (const [paramKey, paramVal] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramVal));
    }
  }
  return text;
}

export function useTranslation() {
  const state = useMwhState();
  const language: SupportedLocale = state.language || 'en';
  const t = (key: string, params?: TranslationParams) => translate(language, key, params);
  return { language, t };
}
