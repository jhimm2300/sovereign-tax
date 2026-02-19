import { AccountingMethod, TransactionType } from "./types";
import {
  Transaction,
  Lot,
  LotDetail,
  SaleRecord,
  CalculationResult,
  createLot,
} from "./models";

/** Calculate days between two ISO date strings */
export function daysBetween(d1: string, d2: string): number {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  const diffMs = date2.getTime() - date1.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Determine if a holding period qualifies as long-term per IRS IRC §1222.
 * The holding period starts the day after acquisition. An asset is long-term
 * if sold on or after the same month/day of the next year + 1 day.
 * This correctly handles leap years and boundary cases.
 */
export function isMoreThanOneYear(acquiredDate: string, soldDate: string): boolean {
  const acquired = new Date(acquiredDate);
  const sold = new Date(soldDate);
  const oneYearLater = new Date(acquired);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  return sold > oneYearLater;
}

/** Format date for display */
function formatDateShort(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Lot selection for Specific Identification method */
export interface LotSelection {
  lotId: string;
  amountBTC: number;
}

/**
 * Cost Basis Engine — pure calculation, no side effects.
 * Supports FIFO, LIFO, HIFO, and Specific Identification methods.
 *
 * Lot IDs are deterministic (derived from source transaction ID) so that
 * Specific ID lot selections in recordedSales can reliably match lots
 * across multiple calculate() calls.
 *
 * recordedSales: optional pre-recorded SaleRecords from Specific ID elections.
 * When a Sell or Donation matches a recorded Specific ID SaleRecord (by date + amount),
 * the engine uses the recorded lot selections instead of auto-selecting.
 * This ensures Specific ID elections are permanent and consistent across all views.
 */
export function calculate(
  transactions: Transaction[],
  method: AccountingMethod,
  recordedSales?: SaleRecord[]
): CalculationResult {
  const lots: Lot[] = [];
  const sales: SaleRecord[] = [];
  const warnings: string[] = [];

  // Build lookup for recorded Specific ID SaleRecords
  // Primary key: sourceTransactionId (unique, collision-proof)
  // Fallback key: date|amount (for pre-v1.3.0 recordings without sourceTransactionId)
  const recordedByTxnId = new Map<string, SaleRecord>();
  const recordedByDateAmount = new Map<string, SaleRecord>();
  if (recordedSales) {
    for (const rs of recordedSales) {
      if (rs.method === AccountingMethod.SpecificID) {
        if (rs.sourceTransactionId) {
          recordedByTxnId.set(rs.sourceTransactionId, rs);
        } else {
          const key = `${rs.saleDate}|${rs.amountSold.toFixed(8)}`;
          recordedByDateAmount.set(key, rs);
        }
      }
    }
  }

  // Sort by date
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  for (const trans of sorted) {
    switch (trans.transactionType) {
      case TransactionType.Buy: {
        // Deterministic lot ID from transaction ID — stable across calculate() calls
        const lot = createLot({
          id: trans.id,
          purchaseDate: trans.date,
          amountBTC: trans.amountBTC,
          pricePerBTC: trans.pricePerBTC,
          totalCost: trans.totalUSD, // Already includes fee (fee added during import)
          fee: trans.fee,
          exchange: trans.exchange,
          wallet: trans.wallet || trans.exchange,
        });
        lots.push(lot);
        break;
      }

      case TransactionType.Sell: {
        // Check for a recorded Specific ID election for this sale
        // Primary: match by transaction ID (collision-proof). Fallback: date|amount (legacy).
        const recorded = recordedByTxnId.get(trans.id)
          || recordedByDateAmount.get(`${trans.date}|${trans.amountBTC.toFixed(8)}`);
        let lotSelections = recorded ? extractLotSelections(recorded, lots) : undefined;
        let effectiveMethod = recorded ? AccountingMethod.SpecificID : method;

        // If recorded but lot matching failed (partial or total), fall back to current method with warning
        if (recorded && lotSelections === null) {
          warnings.push(
            `Specific ID election for sale on ${formatDateShort(trans.date)} could not resolve lot IDs (legacy recording). Using ${method} as fallback.`
          );
          lotSelections = undefined;
          effectiveMethod = method;
        }

        const sale = processSale(trans, lots, effectiveMethod, lotSelections ?? undefined, warnings);
        if (sale) {
          sales.push(sale);
        } else {
          warnings.push(`No lots available for sale on ${formatDateShort(trans.date)}`);
        }
        break;
      }

      case TransactionType.Donation: {
        // Donation consumes lots like a sale but with zero proceeds (non-taxable disposition)
        const originalFmvPerBTC = trans.pricePerBTC;

        // Check for a recorded Specific ID election for this donation
        // Primary: match by transaction ID (collision-proof). Fallback: date|amount (legacy).
        const recorded = recordedByTxnId.get(trans.id)
          || recordedByDateAmount.get(`${trans.date}|${trans.amountBTC.toFixed(8)}`);
        let lotSelections = recorded ? extractLotSelections(recorded, lots) : undefined;
        let effectiveMethod = recorded ? AccountingMethod.SpecificID : method;

        // If recorded but lot matching failed (partial or total), fall back to current method with warning
        if (recorded && lotSelections === null) {
          warnings.push(
            `Specific ID election for donation on ${formatDateShort(trans.date)} could not resolve lot IDs (legacy recording). Using ${method} as fallback.`
          );
          lotSelections = undefined;
          effectiveMethod = method;
        }

        const donationAsSale: Transaction = {
          ...trans,
          pricePerBTC: 0,
          totalUSD: 0,
        };
        const donationResult = processSale(donationAsSale, lots, effectiveMethod, lotSelections ?? undefined, warnings);
        if (donationResult) {
          // Override: zero proceeds, zero gain/loss (donations are not capital gains events per IRC §170)
          donationResult.totalProceeds = 0;
          donationResult.salePricePerBTC = 0;
          donationResult.gainLoss = 0;
          donationResult.isDonation = true;
          // Store original FMV for Form 8283 reporting (pro-rate if partially filled)
          donationResult.donationFmvPerBTC = originalFmvPerBTC;
          donationResult.donationFmvTotal = donationResult.amountSold * originalFmvPerBTC;
          sales.push(donationResult);
        } else {
          warnings.push(`No lots available for donation on ${formatDateShort(trans.date)}`);
        }
        break;
      }

      case TransactionType.TransferIn:
      case TransactionType.TransferOut:
        // Non-taxable movements, do nothing
        break;
    }
  }

  return { lots, sales, warnings };
}

/**
 * Extract lot selections from a recorded SaleRecord.
 * Maps lotDetails back to LotSelection format that processSale() expects.
 * Uses lotId (= source Buy transaction ID, now deterministic) for matching.
 *
 * Legacy migration: pre-v1.2.49 recordings lack lotId on LotDetails.
 * For those, we match against current lots by purchaseDate + costBasisPerBTC
 * to recover the user's original lot election.
 */
function extractLotSelections(recorded: SaleRecord, currentLots?: Lot[]): LotSelection[] | null {
  const selections: LotSelection[] = [];
  const usedLotIds = new Set<string>();
  let unmatchedCount = 0;

  for (const d of recorded.lotDetails) {
    if (d.lotId) {
      // New-style: has deterministic lotId
      selections.push({ lotId: d.lotId, amountBTC: d.amountBTC });
      usedLotIds.add(d.lotId);
    } else if (currentLots) {
      // Legacy migration: match by purchaseDate + costBasisPerBTC + exchange
      // These properties uniquely identify which Buy transaction (= lot) was used
      const match = currentLots.find(
        (lot) =>
          !usedLotIds.has(lot.id) &&
          lot.purchaseDate === d.purchaseDate &&
          Math.abs(lot.pricePerBTC - d.costBasisPerBTC) < 0.005 &&
          lot.exchange === d.exchange
      );
      if (match) {
        selections.push({ lotId: match.id, amountBTC: d.amountBTC });
        usedLotIds.add(match.id);
      } else {
        unmatchedCount++;
      }
    } else {
      unmatchedCount++;
    }
  }

  // If ANY lot details failed to resolve, return null to trigger full fallback.
  // Partial selections are dangerous — they silently under-fill the disposition.
  if (unmatchedCount > 0) return null;

  return selections;
}

/**
 * Simulate a sale without modifying actual lot state.
 * If wallet is provided, enforces per-wallet lot selection (TD 9989).
 */
export function simulateSale(
  amountBTC: number,
  pricePerBTC: number,
  currentLots: Lot[],
  method: AccountingMethod,
  lotSelections?: LotSelection[],
  wallet?: string,
  saleDate?: string
): SaleRecord | null {
  // Deep copy lots
  const lotsCopy: Lot[] = currentLots.map((lot) => ({
    ...lot,
    id: lot.id,
  }));

  const fakeSale: Transaction = {
    id: crypto.randomUUID(),
    date: saleDate || new Date().toISOString(),
    transactionType: TransactionType.Sell,
    amountBTC,
    pricePerBTC,
    totalUSD: amountBTC * pricePerBTC,
    exchange: wallet || "Simulation",
    wallet: wallet,
    notes: "",
  };

  return processSale(fakeSale, lotsCopy, method, lotSelections);
}

/**
 * Process a sale against available lots.
 * MUTATES the lots array (reduces remainingBTC).
 * Enforces per-wallet/per-account cost basis per IRS TD 9989 (effective Jan 1, 2025).
 * Optionally accepts lotSelections for Specific Identification method.
 */
function processSale(
  sale: Transaction,
  lots: Lot[],
  method: AccountingMethod,
  lotSelections?: LotSelection[],
  warnings?: string[]
): SaleRecord | null {
  const amountToSell = sale.amountBTC;
  if (amountToSell <= 0) return null;

  // Per-wallet cost basis enforcement (IRS TD 9989)
  // Filter lots to the same wallet/account as the sale (case-insensitive)
  const normalizeWallet = (w: string | undefined) => (w || "").trim().toLowerCase();
  const saleWallet = sale.wallet || sale.exchange;
  const saleWalletNorm = normalizeWallet(saleWallet);
  let availableIndices = lots
    .map((lot, idx) => ({ lot, idx }))
    .filter(({ lot }) => lot.remainingBTC > 0 && normalizeWallet(lot.wallet || lot.exchange) === saleWalletNorm)
    .map(({ idx }) => idx);

  // Fallback: if no lots match the wallet, use all available lots with a warning
  if (availableIndices.length === 0) {
    availableIndices = lots
      .map((lot, idx) => ({ lot, idx }))
      .filter(({ lot }) => lot.remainingBTC > 0)
      .map(({ idx }) => idx);

    if (availableIndices.length > 0 && warnings) {
      warnings.push(
        `No lots found in wallet "${saleWallet}" for sale on ${formatDateShort(sale.date)}. Fell back to global lot pool.`
      );
    }
  }

  if (availableIndices.length === 0) return null;

  let totalCostBasis = 0;
  const lotDetails: LotDetail[] = [];
  let remainingToSell = amountToSell;
  const holdingDays: number[] = [];

  // Specific Identification: use manual lot selections (restricted to wallet-filtered lots)
  if (method === AccountingMethod.SpecificID && lotSelections && lotSelections.length > 0) {
    const availableSet = new Set(availableIndices);
    for (const sel of lotSelections) {
      if (remainingToSell <= 0) break;
      const lotIdx = lots.findIndex((l) => l.id === sel.lotId);
      if (lotIdx === -1 || !availableSet.has(lotIdx) || lots[lotIdx].remainingBTC <= 0) continue;

      const sellFromLot = Math.min(sel.amountBTC, lots[lotIdx].remainingBTC, remainingToSell);
      // Use fee-inclusive cost basis: totalCost includes exchange fee (cost basis = amount*price + fee)
      const costBasisPerBTC = lots[lotIdx].totalCost / lots[lotIdx].amountBTC;
      const costForPortion = sellFromLot * costBasisPerBTC;
      totalCostBasis += costForPortion;

      const daysHeld = daysBetween(lots[lotIdx].purchaseDate, sale.date);
      holdingDays.push(daysHeld);

      lotDetails.push({
        id: crypto.randomUUID(),
        lotId: lots[lotIdx].id,
        purchaseDate: lots[lotIdx].purchaseDate,
        amountBTC: sellFromLot,
        costBasisPerBTC,
        totalCost: costForPortion,
        daysHeld,
        exchange: lots[lotIdx].exchange,
        wallet: lots[lotIdx].wallet,
        isLongTerm: isMoreThanOneYear(lots[lotIdx].purchaseDate, sale.date),
      });

      lots[lotIdx].remainingBTC -= sellFromLot;
      // Epsilon snap: prevent IEEE 754 float drift from creating phantom lots
      if (lots[lotIdx].remainingBTC > 0 && lots[lotIdx].remainingBTC < 1e-10) {
        lots[lotIdx].remainingBTC = 0;
      }
      remainingToSell -= sellFromLot;
    }
  } else {
    // Standard method: sort indices by method
    let sortedIndices: number[];
    const effectiveMethod = method === AccountingMethod.SpecificID ? AccountingMethod.FIFO : method;
    switch (effectiveMethod) {
      case AccountingMethod.FIFO:
        sortedIndices = availableIndices.sort(
          (a, b) => new Date(lots[a].purchaseDate).getTime() - new Date(lots[b].purchaseDate).getTime()
        );
        break;
      case AccountingMethod.LIFO:
        sortedIndices = availableIndices.sort(
          (a, b) => new Date(lots[b].purchaseDate).getTime() - new Date(lots[a].purchaseDate).getTime()
        );
        break;
      case AccountingMethod.HIFO:
        sortedIndices = availableIndices.sort(
          (a, b) => lots[b].pricePerBTC - lots[a].pricePerBTC
        );
        break;
      default:
        sortedIndices = availableIndices;
    }

    for (const idx of sortedIndices) {
      if (remainingToSell <= 0) break;

      const sellFromLot = Math.min(remainingToSell, lots[idx].remainingBTC);
      // Use fee-inclusive cost basis: totalCost includes exchange fee (cost basis = amount*price + fee)
      const costBasisPerBTC = lots[idx].totalCost / lots[idx].amountBTC;
      const costForPortion = sellFromLot * costBasisPerBTC;
      totalCostBasis += costForPortion;

      const daysHeld = daysBetween(lots[idx].purchaseDate, sale.date);
      holdingDays.push(daysHeld);

      lotDetails.push({
        id: crypto.randomUUID(),
        lotId: lots[idx].id,
        purchaseDate: lots[idx].purchaseDate,
        amountBTC: sellFromLot,
        costBasisPerBTC,
        totalCost: costForPortion,
        daysHeld,
        exchange: lots[idx].exchange,
        wallet: lots[idx].wallet,
        isLongTerm: isMoreThanOneYear(lots[idx].purchaseDate, sale.date),
      });

      lots[idx].remainingBTC -= sellFromLot;
      // Epsilon snap: prevent IEEE 754 float drift from creating phantom lots
      if (lots[idx].remainingBTC > 0 && lots[idx].remainingBTC < 1e-10) {
        lots[idx].remainingBTC = 0;
      }
      remainingToSell -= sellFromLot;
    }
  }

  const amountSold = amountToSell - remainingToSell;
  // Pro-rate proceeds if only partially filled (not enough lots to cover full sale)
  const totalProceeds = amountSold < amountToSell
    ? amountSold * sale.pricePerBTC
    : sale.totalUSD;
  const gainLoss = totalProceeds - totalCostBasis;
  const avgHoldingDays =
    holdingDays.length === 0
      ? 0
      : Math.floor(holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length);

  // Determine term classification from lot details, not averages
  const hasShortTerm = lotDetails.some((d) => !d.isLongTerm);
  const hasLongTerm = lotDetails.some((d) => d.isLongTerm);
  const isMixedTerm = hasShortTerm && hasLongTerm;
  // For non-mixed sales, use lot-level truth; for mixed, isLongTerm=false (use lotDetails for split)
  const isLongTerm = isMixedTerm ? false : hasLongTerm;

  return {
    id: crypto.randomUUID(),
    saleDate: sale.date,
    amountSold,
    salePricePerBTC: sale.pricePerBTC,
    totalProceeds,
    costBasis: totalCostBasis,
    gainLoss,
    fee: amountSold < amountToSell ? (amountSold / amountToSell) * (sale.fee ?? 0) : sale.fee,
    lotDetails,
    holdingPeriodDays: avgHoldingDays,
    isLongTerm,
    isMixedTerm,
    method,
  };
}
