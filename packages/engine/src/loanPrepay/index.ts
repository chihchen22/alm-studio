/**
 * Constant prepayment on level-pay fixed loans: the instrument, its stress speed and the
 * constant-balance walk whose vintages inherit the parent's CPR.
 */
export { ConstantCprFixedLoan, hasLoanPrepay, isKernelDeposit, vintageOf, type PrepayingFixedLoanTerms } from "./constantCprFixedLoan";
export { runStaticBalance } from "./staticBalance";
