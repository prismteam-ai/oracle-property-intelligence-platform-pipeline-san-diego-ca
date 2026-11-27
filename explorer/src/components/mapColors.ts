import type { Point } from '../lib/places';

export interface MapPoint extends Point {
  id: string;
  label: string;
  color: string;
}

/** Marker colours are fixed, not themed, so the legend means the same in light and dark. */
export const MARKER_COLORS = {
  aged: '#e08a00',
  permit: '#2f6fed',
  agent: '#7a4be0',
  ownership: '#0e8f7e',
  outOfArea: '#b0457a',
} as const;
