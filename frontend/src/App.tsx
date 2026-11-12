/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FormEvent, useEffect, useState, type CSSProperties } from 'react';
import { MwhOverlayRoot } from './overlay/MwhOverlayRoot';
import { mwhService } from './services/mwhService';

const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export default function App() {
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
      className="fixed top-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.05] bg-[#1E1F24]/95 px-3 py-1.5 shadow-lg pointer-events-auto"
    >
      <span className="text-[12px] text-[#C8C9D0]">Bearer Token</span>
      <input
        type="password"
        value={tokenDraft}
        autoComplete="off"
        spellCheck={false}
        placeholder="TUNNEL_RUNTIME_TOKEN"
        onChange={(event) => setTokenDraft(event.target.value)}
        className="h-7 w-72 rounded-full bg-black/30 px-3 text-[12px] text-white outline-none"
      />
      <button type="submit" className="h-7 rounded-full bg-[#3B82F6] px-3 text-[12px] text-white">
        认证
      </button>
    </form>
  ) : null;

  return (
    <div className="relative flex w-full h-screen items-center justify-center overflow-hidden bg-[#131315] text-[#ECECEE]">
      <div className="max-w-md rounded-2xl border border-white/[0.05] bg-[#1E1F24]/90 px-6 py-5 text-center shadow-lg">
        <div className="text-[15px] font-medium text-white">Muse-Win-Harness</div>
        <p className="mt-2 text-[13px] leading-relaxed text-[#C8C9D0]">
          完整体验请使用 Muse-Win-Harness 桌面壳；此处仅为浮层调试预览。
        </p>
      </div>
      {authForm}
      <MwhOverlayRoot />
    </div>
  );
}
