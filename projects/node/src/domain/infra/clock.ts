export interface Clock {
  /** Unix time in seconds, the unit of every JWT claim. */
  nowSeconds(): number;
}
