import { createContext, useContext } from 'react';

/** "Now" used for freshness labels. Tests and screenshots pin it; the app uses real time. */
export const ClockContext = createContext<() => Date>(() => new Date());
export const useNow = () => useContext(ClockContext)();
