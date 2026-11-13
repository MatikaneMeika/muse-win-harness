/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FormEvent, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from './i18n';
import { MwhOverlayRoot } from './overlay/MwhOverlayRoot';
import { mwhService } from './services/mwhService';

const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export default function App() {
  const { t } = useTranslation();
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');

  useEffect(() => mwhService.onAuthRequired(setAuthRequired), []);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    void mwhService.submitRuntimeToken(tokenDraft);
  };

  const authForm = authRequired ? (
    <form
      onSubmit={submitToken}
      style={noDragStyle}
      className="fixed top-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.07] bg-[#1C1D20]/95 px-3 py-1.5 shadow-lg pointer-events-auto"
    >
      <span className="text-[12px] text-[#C4C5CC]">Bearer Token</span>
      <input
        type="password"
        value={tokenDraft}
        autoComplete="off"
        spellCheck={false}
        placeholder="TUNNEL_RUNTIME_TOKEN"
        onChange={(event) => setTokenDraft(event.target.value)}
        className="h-7 w-72 rounded-full bg-black/30 px-3 text-[12px] text-white outline-none"
      />
      <button
        type="submit"
        className="h-7 rounded-full bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:bg-[linear-gradient(135deg,#7C3AED_0%,#4F46E5_50%,#2563EB_100%)] px-3.5 text-[12px] font-medium text-white cursor-pointer"
      >
        {t('app.auth')}
      </button>
    </form>
  ) : null;

  return (
    <div className="relative flex w-full h-screen items-center justify-center overflow-hidden bg-[#131315] text-[#ECECEE]">
      <div className="max-w-md rounded-2xl border border-white/[0.06] bg-[#1C1D20]/95 px-6 py-5 text-center shadow-lg">
        <div className="inline-flex items-center justify-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)]" />
          <span className="text-[15px] font-semibold text-white">Muse-Win-Harness</span>
          <span className="rounded-full bg-[#6366F1]/15 px-2 py-0.5 text-[11px] font-medium text-[#A5B4FC]">
            v0.1.0
          </span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-[#C4C5CC]">
          {t('app.previewHint')}
        </p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => mwhService.openSettingsModal('connectors')}
            className="rounded-xl bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] px-3.5 py-1.5 text-xs font-medium text-white cursor-pointer hover:opacity-95"
          >
            {t('app.openSettings')}
          </button>
        </div>
      </div>
      {authForm}
      <MwhOverlayRoot />
    </div>
  );
}
