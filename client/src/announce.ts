import { createContext, useContext } from 'react';

/** Sends a message to the page's polite live region, which screen readers read out. */
export type Announce = (message: string) => void;

export const AnnounceContext = createContext<Announce>(() => {});

export const useAnnounce = (): Announce => useContext(AnnounceContext);
