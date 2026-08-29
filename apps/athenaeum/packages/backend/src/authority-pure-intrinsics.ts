/** The only ambient constructors permitted to pure local handlers. */
export const AUTHORITY_PURE_INTRINSICS = Object.freeze([
  "Object", "Array", "Map", "Set", "WeakMap", "JSON", "Number", "String", "Boolean", "Error", "TypeError", "Reflect", "Symbol", "Date", "Math", "Infinity", "NaN", "undefined"
] as const)
