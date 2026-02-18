import { useState, useCallback, useMemo } from "react";
import { useAppState } from "../lib/app-state";
import { createTransaction, Transaction, SaleRecord } from "../lib/models";
import { TransactionType, TransactionTypeDisplayNames, IncomeType, IncomeTypeDisplayNames } from "../lib/types";
import { AccountingMethod } from "../lib/types";
import { formatUSD, formatBTC, formatDate, formatDateTime, findSimilarTransactions } from "../lib/utils";
import { calculate, simulateSale, LotSelection } from "../lib/cost-basis";
import { LotPicker } from "./LotPicker";
import { HelpPanel } from "./HelpPanel";

export function AddTransactionView() {
  const state = useAppState();
  const [type, setType] = useState(TransactionType.Buy);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [amountStr, setAmountStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [totalStr, setTotalStr] = useState("");
  const [feeStr, setFeeStr] = useState("");
  const [exchange, setExchange] = useState("");
  const [wallet, setWallet] = useState("");
  const [notes, setNotes] = useState("");
  const [incomeType, setIncomeType] = useState<IncomeType | "">("");
  const [useLive, setUseLive] = useState(false);
  const [fmvLoading, setFmvLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Duplicate warning state
  const [pendingTxn, setPendingTxn] = useState<Transaction | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<typeof state.transactions>([]);

  // Donation lot preview state
  const [donationMethod, setDonationMethod] = useState(AccountingMethod.FIFO);
  const [donationPreview, setDonationPreview] = useState<SaleRecord | null>(null);
  const [showLotPicker, setShowLotPicker] = useState(false);
  const [lotSelections, setLotSelections] = useState<LotSelection[] | null>(null);

  // Current lots for donation preview (only computed when needed)
  const currentLots = useMemo(() => {
    if (type !== TransactionType.Donation) return [];
    return calculate(state.allTransactions, donationMethod, state.recordedSales).lots;
  }, [state.allTransactions, donationMethod, type, state.recordedSales]);

  /** Auto-fetch historical FMV for income transactions */
  const fetchFMV = useCallback(async () => {
    if (!date || !state.livePriceEnabled) return;
    setFmvLoading(true);
    setError(null);
    try {
      const price = await state.fetchHistoricalPrice(new Date(date));
      if (price) {
        setPriceStr(price.toFixed(2));
        const amt = Number(amountStr);
        if (amt > 0) setTotalStr((amt * price).toFixed(2));
      } else {
        setError("Could not fetch historical price for this date. Enter manually.");
      }
    } catch {
      setError("Failed to fetch price. Check your internet connection.");
    } finally {
      setFmvLoading(false);
    }
  }, [date, amountStr, state]);

  const isDonationSpecificID = type === TransactionType.Donation && donationMethod === AccountingMethod.SpecificID;

  /** Preview which lots will be consumed by this donation */
  const previewDonationLots = () => {
    setError(null);
    setDonationPreview(null);
    const amount = Number(amountStr);
    if (!amount || amount <= 0) { setError("Enter a valid BTC amount to preview"); return; }

    if (isDonationSpecificID) {
      // Show lot picker for manual selection
      setShowLotPicker(true);
      setLotSelections(null);
      return;
    }

    const walletFilter = wallet || undefined;
    const dateISO = new Date(date + "T12:00:00").toISOString();
    // Simulate with price=0 since donations have no proceeds — we just need the lot details
    const sim = simulateSale(amount, 0, currentLots, donationMethod, undefined, walletFilter, dateISO);
    if (!sim) { setError("Not enough BTC in available lots for this donation amount"); return; }
    setDonationPreview(sim);
  };

  /** Handle lot picker confirmation for Specific ID donations */
  const handleDonationLotConfirm = (selections: LotSelection[]) => {
    setShowLotPicker(false);
    setLotSelections(selections);
    const amount = Number(amountStr);
    const walletFilter = wallet || undefined;
    const dateISO = new Date(date + "T12:00:00").toISOString();
    const sim = simulateSale(amount, 0, currentLots, AccountingMethod.SpecificID, selections, walletFilter, dateISO);
    if (!sim) { setError("Not enough BTC from selected lots"); return; }
    setDonationPreview(sim);
  };

  const handleDonationLotCancel = () => {
    setShowLotPicker(false);
  };

  const commitTransaction = async (txn: Transaction) => {
    await state.addTransaction(txn);

    // For Specific ID donations, save the SaleRecord as a permanent lot election
    if (txn.transactionType === TransactionType.Donation && donationMethod === AccountingMethod.SpecificID && donationPreview && lotSelections) {
      const price = useLive ? state.priceState.currentPrice! : Number(priceStr);
      const saleRecord: SaleRecord = {
        ...donationPreview,
        id: crypto.randomUUID(),
        saleDate: txn.date,
        isDonation: true,
        donationFmvPerBTC: price,
        donationFmvTotal: donationPreview.amountSold * price,
        method: AccountingMethod.SpecificID,
      };
      await state.recordSale(saleRecord);
    }

    setSuccess(`${TransactionTypeDisplayNames[txn.transactionType]} of ${formatBTC(txn.amountBTC)} BTC added`);
    setAmountStr(""); setPriceStr(""); setTotalStr(""); setFeeStr(""); setWallet(""); setNotes(""); setIncomeType("");
    setPendingTxn(null);
    setDuplicateMatches([]);
    setDonationPreview(null);
    setLotSelections(null);
    setShowLotPicker(false);
  };

  const handleAdd = async () => {
    setError(null); setSuccess(null);
    const amount = Number(amountStr);
    if (!amount || amount <= 0) { setError("Enter a valid BTC amount"); return; }
    const price = useLive ? state.priceState.currentPrice! : Number(priceStr);
    const isTransfer = type === TransactionType.TransferIn || type === TransactionType.TransferOut;
    if (!isTransfer && (!price || price <= 0)) { setError(type === TransactionType.Donation ? "Enter the Fair Market Value (FMV) per BTC on the date of donation" : "Enter a valid price"); return; }
    let total = Number(totalStr);
    if (!total || total <= 0) total = amount * (price || 0);
    const fee = Number(feeStr) || 0;

    // Apply fee: buys add fee to cost basis, sells subtract from proceeds
    let adjustedTotal = total;
    let adjustedPrice = price;
    if (fee > 0) {
      if (type === TransactionType.Buy) {
        adjustedTotal = total + fee;
      } else if (type === TransactionType.Sell) {
        adjustedTotal = Math.max(0, total - fee);
      }
      if (amount > 0) adjustedPrice = adjustedTotal / amount;
    }

    const finalExchange = exchange || "Manual";
    const txn = createTransaction({
      date: new Date(date + "T12:00:00").toISOString(),
      transactionType: type,
      amountBTC: amount,
      pricePerBTC: adjustedPrice,
      totalUSD: adjustedTotal,
      fee: fee > 0 ? fee : undefined,
      exchange: finalExchange,
      wallet: wallet || finalExchange,
      incomeType: type === TransactionType.Buy && incomeType ? incomeType : undefined,
      notes,
    });

    // Check for similar existing transactions
    const similar = findSimilarTransactions(state.transactions, type, txn.date, amount);
    if (similar.length > 0) {
      setPendingTxn(txn);
      setDuplicateMatches(similar);
      return;
    }

    await commitTransaction(txn);
  };

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-3xl font-bold mb-1">Add Transaction</h1>
      <HelpPanel subtitle="Manually add a buy, sell, transfer, donation, or income transaction that wasn't in a CSV import." />

      <div className="card space-y-4">
        {/* Type */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Type:</span>
          <div className="segmented">
            {Object.values(TransactionType).map((t) => (
              <button key={t} className={`segmented-btn ${type === t ? "active" : ""}`} onClick={() => { setType(t); setDonationPreview(null); }}>
                {TransactionTypeDisplayNames[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Income Type (only for Buy) */}
        {type === TransactionType.Buy && (
          <div className="flex items-center gap-4">
            <span className="w-24 text-right text-gray-500">Income Type:</span>
            <select className="select w-48" value={incomeType} onChange={(e) => setIncomeType(e.target.value as IncomeType | "")}>
              <option value="">Not Income (Regular Buy)</option>
              {Object.values(IncomeType).map((it) => (
                <option key={it} value={it}>{IncomeTypeDisplayNames[it]}</option>
              ))}
            </select>
            <span className="text-xs text-gray-400">(optional — for mining, rewards, etc.)</span>
          </div>
        )}

        {/* Donation Method Selector */}
        {type === TransactionType.Donation && (
          <div className="flex items-center gap-4">
            <span className="w-24 text-right text-gray-500">Method:</span>
            <div className="segmented">
              {[AccountingMethod.FIFO, AccountingMethod.LIFO, AccountingMethod.HIFO, AccountingMethod.SpecificID].map((m) => (
                <button key={m} className={`segmented-btn ${donationMethod === m ? "active" : ""}`} onClick={() => { setDonationMethod(m); setDonationPreview(null); setShowLotPicker(false); setLotSelections(null); }}>
                  {m}
                </button>
              ))}
            </div>
            <span className="text-xs text-gray-400">{isDonationSpecificID ? "Choose exactly which lots to donate" : "Controls which lots are consumed"}</span>
          </div>
        )}

        {/* Date */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Date:</span>
          <input type="date" className="input w-48" value={date} onChange={(e) => { setDate(e.target.value); setDonationPreview(null); }} />
        </div>

        {/* Amount */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">BTC Amount:</span>
          <input className="input w-48" placeholder="0.00000000" value={amountStr} onChange={(e) => { setAmountStr(e.target.value); setDonationPreview(null); }} />
        </div>

        {/* Price */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">{type === TransactionType.Donation ? "FMV/BTC:" : "Price/BTC:"}</span>
          {useLive ? (
            <span className="font-medium tabular-nums">{state.priceState.currentPrice ? formatUSD(state.priceState.currentPrice) : "..."}</span>
          ) : (
            <input className="input w-48" placeholder="0.00" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} />
          )}
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={useLive} onChange={(e) => { setUseLive(e.target.checked); if (e.target.checked) state.fetchPrice(); }} />
            Live Price
          </label>
          {((type === TransactionType.Buy && incomeType) || type === TransactionType.Donation) && !useLive && state.livePriceEnabled && (
            <button
              className="btn-secondary text-xs px-3 py-1"
              onClick={fetchFMV}
              disabled={fmvLoading || !date}
            >
              {fmvLoading ? "Fetching..." : "Fetch FMV"}
            </button>
          )}
        </div>
        {type === TransactionType.Donation && (
          <div className="flex items-center gap-4">
            <span className="w-24" />
            <span className="text-xs text-purple-500">Donations consume lots but are not taxable events. Enter FMV for your charitable deduction records.</span>
          </div>
        )}

        {/* Total */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Total USD:</span>
          <input className="input w-48" placeholder="Auto-calculated" value={totalStr} onChange={(e) => setTotalStr(e.target.value)} />
          <span className="text-xs text-gray-400">(optional)</span>
        </div>

        {/* Fee */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Fee USD:</span>
          <input className="input w-48" placeholder="0.00" value={feeStr} onChange={(e) => setFeeStr(e.target.value)} />
          <span className="text-xs text-gray-400">(optional — added to cost basis for buys, subtracted from proceeds for sells)</span>
        </div>

        {/* Exchange */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Exchange:</span>
          <input className="input w-48" placeholder="e.g., Coinbase" value={exchange} onChange={(e) => setExchange(e.target.value)} />
        </div>

        {/* Wallet */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Wallet:</span>
          <input className="input w-48" placeholder="Defaults to exchange" value={wallet} onChange={(e) => setWallet(e.target.value)} />
          <span className="text-xs text-gray-400">(optional — for per-wallet cost basis tracking)</span>
        </div>

        {/* Notes */}
        <div className="flex items-center gap-4">
          <span className="w-24 text-right text-gray-500">Notes:</span>
          <input className="input w-72" placeholder="Optional notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={100} />
          <span className="text-xs text-gray-400">{notes.length}/100</span>
        </div>

        <div className="flex gap-3 pt-2">
          <button className="btn-primary" onClick={async () => { await handleAdd(); }}>➕ Add Transaction</button>
          {type === TransactionType.Donation && (
            <button className="btn-secondary" onClick={previewDonationLots}>
              {isDonationSpecificID ? "🔍 Select Lots" : "🔍 Preview Lot Consumption"}
            </button>
          )}
        </div>
      </div>

      {/* Lot Picker for Specific ID Donations */}
      {showLotPicker && isDonationSpecificID && (
        <div className="mt-4">
          <LotPicker
            lots={wallet
              ? currentLots.filter((l) => (l.wallet || l.exchange || "").toLowerCase() === wallet.toLowerCase())
              : currentLots}
            targetAmount={Number(amountStr)}
            onConfirm={handleDonationLotConfirm}
            onCancel={handleDonationLotCancel}
          />
        </div>
      )}

      {/* Donation Lot Preview */}
      {donationPreview && type === TransactionType.Donation && (
        <div className="card mt-4 border-l-4 border-l-purple-500">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-purple-700 dark:text-purple-400">Lot Consumption Preview ({donationMethod})</h3>
            <span className="text-xs text-purple-500 font-medium">PREVIEW — not yet recorded</span>
          </div>
          {isDonationSpecificID && lotSelections && (
            <div className="text-xs text-blue-500 mb-2">Using Specific Identification — {lotSelections.length} lot(s) manually selected</div>
          )}
          <p className="text-xs text-gray-500 mb-3">
            These lots will be consumed when this donation is processed. Long-term lots (held &gt;1 year) qualify for a deduction at full Fair Market Value. Short-term lots are deductible at cost basis only.
          </p>

          {/* Lot details table */}
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 text-xs font-semibold text-gray-500 pb-2 border-b border-gray-200 dark:border-gray-700 mb-1">
            <div>Purchase Date</div>
            <div className="text-right">BTC Amount</div>
            <div className="text-right">Cost Basis</div>
            <div className="text-right">Days Held</div>
            <div>Term</div>
          </div>
          {donationPreview.lotDetails.map((d, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 py-1.5 text-sm border-b border-gray-100 dark:border-gray-800">
              <div>{formatDate(d.purchaseDate)}</div>
              <div className="text-right tabular-nums">{formatBTC(d.amountBTC)}</div>
              <div className="text-right tabular-nums">{formatUSD(d.totalCost)}</div>
              <div className="text-right tabular-nums">{d.daysHeld}</div>
              <div>
                <span className={`badge ${d.isLongTerm ? "badge-green" : "badge-orange"} text-xs`}>
                  {d.isLongTerm ? "Long-term" : "Short-term"}
                </span>
              </div>
            </div>
          ))}

          {/* Summary */}
          <div className="mt-3 flex gap-6 text-sm">
            <div>
              <span className="text-gray-500">Total BTC:</span>{" "}
              <span className="tabular-nums font-medium">{formatBTC(donationPreview.amountSold)}</span>
            </div>
            <div>
              <span className="text-gray-500">Total Cost Basis:</span>{" "}
              <span className="tabular-nums font-medium">{formatUSD(donationPreview.costBasis)}</span>
            </div>
            <div>
              <span className="text-gray-500">Term:</span>{" "}
              <span className={`badge ${donationPreview.isLongTerm ? "badge-green" : donationPreview.isMixedTerm ? "badge-blue" : "badge-orange"} text-xs`}>
                {donationPreview.isMixedTerm ? "Mixed" : donationPreview.isLongTerm ? "Long-term" : "Short-term"}
              </span>
            </div>
          </div>
        </div>
      )}

      {success && <div className="bg-green-50 dark:bg-green-900/20 text-green-600 p-4 rounded-lg mt-4">✅ {success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/20 text-red-500 p-4 rounded-lg mt-4">⚠️ {error}</div>}

      {/* Duplicate Warning Modal */}
      {pendingTxn && duplicateMatches.length > 0 && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setPendingTxn(null); setDuplicateMatches([]); }}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 max-w-lg w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-2 text-orange-500">Possible Duplicate</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              A similar transaction already exists. Adding this could cause duplicate entries, which will produce incorrect tax calculations (e.g., double-counting a sale).
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              This can happen if you manually add a transaction that also appears in a CSV import.
            </p>

            <div className="bg-gray-50 dark:bg-zinc-800 rounded-lg p-3 mb-4 text-sm space-y-1">
              <p className="font-semibold text-gray-700 dark:text-gray-300 mb-2">Existing match{duplicateMatches.length > 1 ? "es" : ""}:</p>
              {duplicateMatches.map((m) => (
                <div key={m.id} className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                  <span className="tabular-nums">{formatDateTime(m.date)}</span>
                  <span>{TransactionTypeDisplayNames[m.transactionType]}</span>
                  <span className="tabular-nums">{formatBTC(m.amountBTC)} BTC</span>
                  <span className="text-gray-400">{m.exchange}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-3 justify-end">
              <button className="btn-secondary text-sm" onClick={() => { setPendingTxn(null); setDuplicateMatches([]); }}>Cancel</button>
              <button
                className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
                onClick={async () => { await commitTransaction(pendingTxn); }}
              >
                Add Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
