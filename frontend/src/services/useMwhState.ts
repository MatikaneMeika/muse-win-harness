import { useEffect, useState } from 'react';
import { mwhService, MwhState } from './mwhService';

export function useMwhState(): MwhState {
  const [state, setState] = useState<MwhState>(() => mwhService.getState());

  useEffect(() => {
    return mwhService.subscribe(setState);
  }, []);

  return state;
}
