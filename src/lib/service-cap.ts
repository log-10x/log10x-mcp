/**
 * Where a per-service cap sits between what the plan keeps and what it moves.
 *
 * Both figures are the container's statements at their busiest window, in
 * the unit the cap is written in. The cap sits at the geometric mean of the
 * largest kept statement and the smallest moved one, so each side has the
 * same ratio of margin: the kept statement can grow by that factor before it
 * is held, and the moved one is that factor above the limit. When the
 * smallest moved statement is no busier than the largest kept one, no cap
 * separates them; the cap stays at the largest kept statement and the plan
 * says so.
 */

export interface ServiceCapPlacement {
  /** The cap, in the unit of its inputs. */
  cap: number;
  keptMax: number;
  movedMin?: number;
  /** True when the cap sits strictly between the two. */
  separated: boolean;
  /** cap / keptMax, which equals movedMin / cap, when separated. */
  margin?: number;
}

export function placeServiceCap(keptMax: number, movedMin: number | undefined): ServiceCapPlacement {
  if (!(keptMax > 0) || movedMin === undefined || !Number.isFinite(movedMin)) {
    return { cap: keptMax, keptMax, ...(movedMin !== undefined ? { movedMin } : {}), separated: false };
  }
  if (movedMin <= keptMax) return { cap: keptMax, keptMax, movedMin, separated: false };
  const cap = Math.sqrt(keptMax * movedMin);
  return { cap, keptMax, movedMin, separated: true, margin: cap / keptMax };
}

/** "1.6x", no trailing zero. */
export function fmtMargin(m: number): string {
  return `${Number(m.toFixed(1))}x`;
}

/**
 * The margin in the reader's terms, one sentence per service, or undefined
 * when the service keeps nothing or moves nothing.
 */
export function marginSentence(
  service: string,
  p: Pick<ServiceCapPlacement, 'separated' | 'margin' | 'keptMax' | 'movedMin'>,
  keptNoun: string,
): string | undefined {
  if (p.separated && p.margin !== undefined) {
    const m = fmtMargin(p.margin);
    return `${service}: the largest kept statement can grow ${m} before it is held; the smallest moved one is ${m} above the limit.`;
  }
  if (p.keptMax > 0 && p.movedMin !== undefined) {
    return (
      `${service}: no limit separates the statements, because the smallest one moved is no busier than the largest one kept; ` +
      `the limit stays at the largest kept statement, and a moved statement under it stays in ${keptNoun}.`
    );
  }
  return undefined;
}
