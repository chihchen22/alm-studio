/**
 * Public MMA EVE discount grid — 17-node RFR zero + TLP spread curve.
 *
 * GENERATED from public/market_public.json
 * (published U.S. Treasury constant-maturity par yields, H.15 via FRED, as of
 * 2026-03-31, bootstrapped as the RFR discount basis). Public source data; no
 * vendor input.
 */

export interface MmaEveCurve {
  readonly t: readonly number[];
  readonly z: readonly number[];
  readonly tlp: readonly number[];
}

export const MMA_EVE_CURVE_PUBLIC: MmaEveCurve = {
  t: [
    0.08333333333333333, 0.25, 0.5, 1, 2, 3,
    4, 5, 6, 7, 8, 9,
    10, 15, 20, 25, 30,
  ],
  z: [
    0.0370546084423771, 0.036661913369446915, 0.03685827093673421, 0.03646192372677316,
    0.03756676742125343, 0.03776394516683207, 0.03833520569909118, 0.03890646623135029,
    0.03993445240323482, 0.04096243857511936, 0.04166866318677131, 0.04237488779842326,
    0.0430811124100752, 0.04688480629063793, 0.05068850017120067, 0.05026484216799748,
    0.04984118416479429,
  ],
  tlp: [
    0.002, 0.002, 0.0025, 0.0025,
    0.003, 0.0035, 0.004, 0.0045,
    0.004999999999999999, 0.0055, 0.005833333333333334, 0.006166666666666667,
    0.0065, 0.00775, 0.009, 0.0095,
    0.01,
  ],
};
