import { useMemo, useState } from "react";
import { useAppState } from "../lib/app-state";
import { reconcileTransfers, MatchConfidence, TransferPair, daysBetweenDates } from "../lib/reconciliation";
import { formatBTC, formatDate } from "../lib/utils";
import { Transaction } from "../lib/models";
import { HelpPanel } from "./HelpPanel";

export function ReconciliationView() {
  const { allTransactions, setSelectedNav } = useAppState();

  const result = useMemo(() => reconcileTransfers(allTransactions), [allTransactions]);

  // Local state for flagged pair review
  const [approvedFlags, setApprovedFlags] = useState<Set<string>>(new Set());
  const [rejectedFlags, setRejectedFlags] = useState<Set<string>>(new Set());

  // Local state for manual matching
  const [manualMatches, setManualMatches] = useState<TransferPair[]>([]);
  const [selectedOutId, setSelectedOutId] = useState<string | null>(null);
  const [selectedInId, setSelectedInId] = useState<string | null>(null);

  // Split auto-matched pairs by confidence
  const confidentPairs = result.matchedTransfers.filter((p) => p.confidence === MatchConfidence.Confident);
  const flaggedPairs = result.matchedTransfers.filter((p) => p.confidence === MatchConfidence.Flagged);

  // Flagged pairs that haven't been reviewed yet
  const pendingFlagged = flaggedPairs.filter((p) => {
    const key = pairKey(p);
    return !approvedFlags.has(key) && !rejectedFlags.has(key);
  });
  const approvedFlaggedPairs = flaggedPairs.filter((p) => approvedFlags.has(pairKey(p)));
  const rejectedFlaggedPairs = flaggedPairs.filter((p) => rejectedFlags.has(pairKey(p)));

  // Effective unmatched = original unmatched + rejected flagged transfers - manually matched
  const manualOutIds = new Set(manualMatches.map((m) => m.transferOut.id));
  const manualInIds = new Set(manualMatches.map((m) => m.transferIn.id));

  const effectiveUnmatchedOuts = [
    ...result.unmatchedTransferOuts,
    ...rejectedFlaggedPairs.map((p) => p.transferOut),
  ].filter((t) => !manualOutIds.has(t.id));

  const effectiveUnmatchedIns = [
    ...result.unmatchedTransferIns,
    ...rejectedFlaggedPairs.map((p) => p.transferIn),
  ].filter((t) => !manualInIds.has(t.id));

  // All confirmed matches for display
  const allConfirmedPairs = [...confidentPairs, ...approvedFlaggedPairs, ...manualMatches];

  // Manual match helpers
  const selectedOut = effectiveUnmatchedOuts.find((t) => t.id === selectedOutId) ?? null;
  const selectedIn = effectiveUnmatchedIns.find((t) => t.id === selectedInId) ?? null;

  const handleApproveFlag = (pair: TransferPair) => {
    setApprovedFlags((prev) => new Set(prev).add(pairKey(pair)));
  };

  const handleRejectFlag = (pair: TransferPair) => {
    setRejectedFlags((prev) => new Set(prev).add(pairKey(pair)));
  };

  const handleManualMatch = () => {
    if (!selectedOut || !selectedIn) return;
    const impliedFee = Math.max(0, selectedOut.amountBTC - selectedIn.amountBTC);
    const days = daysBetweenDates(selectedOut.date, selectedIn.date);
    const newPair: TransferPair = {
      transferOut: selectedOut,
      transferIn: selectedIn,
      amountBTC: selectedOut.amountBTC,
      daysBetween: days,
      impliedFeeBTC: impliedFee,
      confidence: MatchConfidence.Confident, // User explicitly confirmed
    };
    setManualMatches((prev) => [...prev, newPair]);
    setSelectedOutId(null);
    setSelectedInId(null);
  };

  if (allTransactions.length === 0) {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-full">
        <div className="text-5xl mb-4 opacity-50">🔍</div>
        <h2 className="text-xl text-gray-500 mb-2">No data to reconcile</h2>
        <p className="text-gray-400 mb-4">Import transactions first</p>
        <button className="btn-secondary" onClick={() => setSelectedNav("import")}>Go to Import</button>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-3xl font-bold mb-1">Reconciliation</h1>
      <HelpPanel
        subtitle="Match transfers between exchanges and identify missing data."
        expandedContent={
          <>
            <p><strong>How matching works:</strong> A withdrawal from one exchange is paired with a deposit at another within a 7-day window. Miner fees are accounted for — the received amount can be less than the sent amount.</p>
            <p><strong>Flagged matches:</strong> Transfers with an unusually high implied miner fee (above 0.0005 BTC) are flagged for your review. You can approve or reject them.</p>
            <p><strong>Manual matching:</strong> If a transfer wasn't auto-matched, you can select one outgoing and one incoming transfer to link them manually.</p>
            <p><strong>Unmatched transfers:</strong> Withdrawals to your own cold storage wallet will appear as unmatched — this is normal and does not indicate a problem.</p>
            <p><strong>Exchange balances:</strong> Net BTC balance per exchange is computed from all buys, sells, transfers, and donations. A negative balance may indicate missing import data.</p>
          </>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="card">
          <div className="text-xs text-gray-500 mb-1">Matched</div>
          <div className="text-xl font-semibold text-green-600">{allConfirmedPairs.length}</div>
        </div>
        <div className="card">
          <div className="text-xs text-gray-500 mb-1">Flagged for Review</div>
          <div className={`text-xl font-semibold ${pendingFlagged.length > 0 ? "text-orange-500" : "text-green-600"}`}>
            {pendingFlagged.length}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-gray-500 mb-1">Unmatched Out</div>
          <div className={`text-xl font-semibold ${effectiveUnmatchedOuts.length > 0 ? "text-orange-500" : "text-green-600"}`}>
            {effectiveUnmatchedOuts.length}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-gray-500 mb-1">Unmatched In</div>
          <div className={`text-xl font-semibold ${effectiveUnmatchedIns.length > 0 ? "text-orange-500" : "text-green-600"}`}>
            {effectiveUnmatchedIns.length}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-gray-500 mb-1">Exchanges</div>
          <div className="text-xl font-semibold">{result.exchangeBalances.length}</div>
        </div>
      </div>

      {/* Exchange Balances */}
      <div className="card mb-6">
        <h3 className="font-semibold mb-3">Exchange Balances</h3>
        <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-gray-500 pb-2 border-b border-gray-200 dark:border-gray-700">
          <div>Exchange</div>
          <div className="text-right">Total In (BTC)</div>
          <div className="text-right">Total Out (BTC)</div>
          <div className="text-right">Net Balance</div>
        </div>
        {result.exchangeBalances.map((b) => (
          <div key={b.exchange} className="grid grid-cols-4 gap-2 py-2 text-sm border-b border-gray-100 dark:border-gray-800">
            <div className="font-medium">{b.exchange}</div>
            <div className="text-right tabular-nums">{formatBTC(b.totalIn)}</div>
            <div className="text-right tabular-nums">{formatBTC(b.totalOut)}</div>
            <div className={`text-right tabular-nums font-medium ${b.netBalance < -0.00000001 ? "text-red-500" : "text-green-600"}`}>
              {formatBTC(b.netBalance)}
            </div>
          </div>
        ))}
      </div>

      {/* Flagged for Review */}
      {pendingFlagged.length > 0 && (
        <div className="card mb-6 border-l-4 border-l-orange-500">
          <h3 className="font-semibold mb-2 flex items-center gap-2">
            <span className="text-orange-500">⚠</span> Flagged for Review ({pendingFlagged.length})
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            These transfers were auto-matched but have an unusually high implied miner fee. Please verify they are the same transfer.
          </p>
          {pendingFlagged.map((pair) => (
            <div key={pairKey(pair)} className="flex items-center gap-3 py-2 text-sm border-b border-gray-100 dark:border-gray-800">
              <span className="text-orange-500">⚠</span>
              <span>{formatDate(pair.transferOut.date)}</span>
              <span className="font-medium">{pair.transferOut.exchange}</span>
              <span className="text-gray-400">→</span>
              <span className="font-medium">{pair.transferIn.exchange}</span>
              <span className="flex-1" />
              <span className="tabular-nums text-xs">
                {formatBTC(pair.transferOut.amountBTC)} → {formatBTC(pair.transferIn.amountBTC)}
              </span>
              <span className="text-orange-500 font-medium text-xs tabular-nums" title="Implied miner fee">
                Fee: {formatBTC(pair.impliedFeeBTC)}
              </span>
              <span className="text-xs text-gray-400">{pair.daysBetween}d</span>
              <button
                className="text-xs px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-white"
                onClick={() => handleApproveFlag(pair)}
              >
                Approve
              </button>
              <button
                className="text-xs px-2 py-1 rounded bg-red-500 hover:bg-red-600 text-white"
                onClick={() => handleRejectFlag(pair)}
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Matched Transfers (confirmed) */}
      {allConfirmedPairs.length > 0 && (
        <div className="card mb-6">
          <h3 className="font-semibold mb-3">Matched Transfer Pairs ({allConfirmedPairs.length})</h3>
          {allConfirmedPairs.map((pair, i) => (
            <div key={i} className="flex items-center gap-3 py-2 text-sm border-b border-gray-100 dark:border-gray-800">
              <span className="text-green-500">✓</span>
              <span>{formatDate(pair.transferOut.date)}</span>
              <span className="font-medium">{pair.transferOut.exchange}</span>
              <span className="text-gray-400">→</span>
              <span className="font-medium">{pair.transferIn.exchange}</span>
              <span className="flex-1" />
              <span className="tabular-nums">{formatBTC(pair.amountBTC)} BTC</span>
              {pair.impliedFeeBTC > 0.00000001 && (
                <span className="text-xs text-gray-400 tabular-nums" title="Implied miner fee">
                  fee: {formatBTC(pair.impliedFeeBTC)}
                </span>
              )}
              <span className="text-xs text-gray-400">{pair.daysBetween}d</span>
            </div>
          ))}
        </div>
      )}

      {/* Unmatched Transfers + Manual Matching */}
      {(effectiveUnmatchedOuts.length > 0 || effectiveUnmatchedIns.length > 0) && (
        <div className="card mb-6">
          <h3 className="font-semibold mb-2">Unmatched Transfers</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Unmatched outgoing transfers are common and usually not an issue — most are withdrawals to your own cold storage or self-custody wallet.
            You can manually match a pair by selecting one outgoing and one incoming transfer below.
          </p>

          {/* Manual match: two-column selection */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            {/* Unmatched Outs */}
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-2">Outgoing ({effectiveUnmatchedOuts.length})</div>
              {effectiveUnmatchedOuts.length === 0 ? (
                <p className="text-xs text-gray-400">None</p>
              ) : (
                effectiveUnmatchedOuts.map((t) => (
                  <UnmatchedRow
                    key={t.id}
                    transaction={t}
                    direction="out"
                    isSelected={selectedOutId === t.id}
                    onSelect={() => setSelectedOutId(selectedOutId === t.id ? null : t.id)}
                  />
                ))
              )}
            </div>

            {/* Unmatched Ins */}
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-2">Incoming ({effectiveUnmatchedIns.length})</div>
              {effectiveUnmatchedIns.length === 0 ? (
                <p className="text-xs text-gray-400">None</p>
              ) : (
                effectiveUnmatchedIns.map((t) => (
                  <UnmatchedRow
                    key={t.id}
                    transaction={t}
                    direction="in"
                    isSelected={selectedInId === t.id}
                    onSelect={() => setSelectedInId(selectedInId === t.id ? null : t.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Manual match confirmation bar */}
          {selectedOut && selectedIn && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-3 rounded-lg">
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <span className="font-medium">{selectedOut.exchange}</span>
                <span className="text-gray-400">→</span>
                <span className="font-medium">{selectedIn.exchange}</span>
                <span className="text-gray-400">|</span>
                <span className="tabular-nums">{formatBTC(selectedOut.amountBTC)}</span>
                <span className="text-gray-400">→</span>
                <span className="tabular-nums">{formatBTC(selectedIn.amountBTC)}</span>
                <span className="text-gray-400">|</span>
                {(() => {
                  const fee = Math.max(0, selectedOut.amountBTC - selectedIn.amountBTC);
                  const isHighFee = fee > 0.0005;
                  const isNegative = selectedIn.amountBTC > selectedOut.amountBTC + 0.00000001;
                  return (
                    <span className={`tabular-nums font-medium text-xs ${isNegative ? "text-red-500" : isHighFee ? "text-orange-500" : "text-gray-600 dark:text-gray-400"}`}>
                      {isNegative ? "⚠ In > Out" : `Implied fee: ${formatBTC(fee)} BTC`}
                      {isHighFee && !isNegative && " ⚠ High"}
                    </span>
                  );
                })()}
                <span className="flex-1" />
                <button
                  className="btn-primary text-xs px-3 py-1"
                  onClick={handleManualMatch}
                >
                  Confirm Match
                </button>
                <button
                  className="btn-secondary text-xs px-3 py-1"
                  onClick={() => { setSelectedOutId(null); setSelectedInId(null); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Suggestions */}
      {result.suggestedMissing.length > 0 && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg">
          <h3 className="font-semibold mb-2 flex items-center gap-2"><span>💡</span> Suggestions</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {result.suggestedMissing.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Unique key for a transfer pair (for Set tracking) */
function pairKey(pair: TransferPair): string {
  return `${pair.transferOut.id}|${pair.transferIn.id}`;
}

/** Selectable row for an unmatched transfer */
function UnmatchedRow({
  transaction,
  direction,
  isSelected,
  onSelect,
}: {
  transaction: Transaction;
  direction: "out" | "in";
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 py-2 px-2 text-sm border-b border-gray-100 dark:border-gray-800 cursor-pointer rounded ${
        isSelected ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800" : "hover:bg-gray-50 dark:hover:bg-zinc-800/50"
      }`}
      onClick={onSelect}
    >
      <input
        type="radio"
        checked={isSelected}
        onChange={onSelect}
        className="accent-orange-500"
        onClick={(e) => e.stopPropagation()}
      />
      <span className={`badge ${direction === "out" ? "badge-orange" : "badge-blue"} text-xs`}>
        {direction === "out" ? "Out" : "In"}
      </span>
      <span className="text-xs">{formatDate(transaction.date)}</span>
      <span className="font-medium text-xs">{transaction.exchange}</span>
      <span className="flex-1" />
      <span className="tabular-nums text-xs">{formatBTC(transaction.amountBTC)}</span>
    </div>
  );
}
