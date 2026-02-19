import { useMemo } from "react";
import { useAppState } from "../lib/app-state";
import { calculate } from "../lib/cost-basis";
import { formatUSD } from "../lib/utils";
import { AccountingMethod, AccountingMethodDisplayNames } from "../lib/types";
import { HelpPanel } from "./HelpPanel";

interface MethodResult {
  method: AccountingMethod;
  totalGL: number;
  stGL: number;
  ltGL: number;
  salesCount: number;
}

// Exclude SpecificID from auto-comparison (requires manual lot selection)
// Module-level constant so useMemo dependency is stable across renders
const comparableMethods = Object.values(AccountingMethod).filter((m) => m !== AccountingMethod.SpecificID);

export function ComparisonView() {
  const { allTransactions, selectedYear, setSelectedYear, availableYears, setSelectedNav, recordedSales } = useAppState();

  const results: MethodResult[] = useMemo(() => {
    return comparableMethods.map((method) => {
      const calc = calculate(allTransactions, method, recordedSales);
      const salesForYear = calc.sales.filter((s) => new Date(s.saleDate).getFullYear() === selectedYear);
      // Exclude donations from stGL/ltGL — they have salePricePerBTC=0 which would produce phantom losses
      const taxableSales = salesForYear.filter((s) => !s.isDonation);
      return {
        method,
        totalGL: salesForYear.reduce((a, s) => a + s.gainLoss, 0),
        stGL: taxableSales.reduce((a, s) => a + s.lotDetails.filter((d) => !d.isLongTerm).reduce((sum, d) => sum + (d.amountBTC * s.salePricePerBTC - d.totalCost), 0), 0),
        ltGL: taxableSales.reduce((a, s) => a + s.lotDetails.filter((d) => d.isLongTerm).reduce((sum, d) => sum + (d.amountBTC * s.salePricePerBTC - d.totalCost), 0), 0),
        salesCount: salesForYear.filter((s) => !s.isDonation).length,
      };
    });
  }, [allTransactions, selectedYear, recordedSales]);

  const bestMethod = results.reduce((best, r) => (r.totalGL < best.totalGL ? r : best), results[0]);

  if (allTransactions.length === 0) {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-full">
        <div className="text-5xl mb-4 opacity-50">⚖️</div>
        <h2 className="text-xl text-gray-500 mb-2">No data to compare</h2>
        <p className="text-gray-400 mb-4">Import transactions first</p>
        <button className="btn-secondary" onClick={() => setSelectedNav("import")}>Go to Import</button>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-3xl font-bold mb-1">Compare Methods</h1>
      <HelpPanel
        subtitle="Capital gains summary using FIFO — the IRS default method. Use Specific Identification in Record Sale to manually select lots."
        expandedContent={
          <>
            <p><strong>FIFO (First In, First Out):</strong> Sells oldest lots first. This is the IRS default method when specific lots are not identified before the sale.</p>
            <p><strong>Specific Identification:</strong> Lets you choose exactly which lots to sell. Must be elected before or at the time of disposal. Use the Record Sale view to make Specific ID elections.</p>
          </>
        }
      />

      <div className="flex items-center gap-3 mb-6">
        <span className="text-gray-500">Tax Year:</span>
        <select className="select" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
          {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Bar chart visualization */}
      <div className="card mb-6">
        <div className="flex items-end justify-center gap-8 h-56 pt-4">
          {results.map((r) => {
            const maxAbs = Math.max(...results.map((x) => Math.abs(x.totalGL)), 1);
            const height = Math.abs(r.totalGL) / maxAbs * 150;
            const isGain = r.totalGL >= 0;
            return (
              <div key={r.method} className="flex flex-col items-center">
                <span className={`text-sm font-medium tabular-nums mb-1 ${isGain ? "text-green-600" : "text-red-500"}`}>
                  {formatUSD(r.totalGL)}
                </span>
                <div
                  className={`w-20 rounded-t ${isGain ? "bg-green-500" : "bg-red-500"}`}
                  style={{ height: `${Math.max(height, 4)}px` }}
                />
                <div className="text-sm font-semibold mt-2">{r.method}</div>
                <div className="text-xs text-gray-500">{AccountingMethodDisplayNames[r.method]}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary table */}
      <div className="card mb-6">
        <div className={`grid grid-cols-2 gap-4`}>
          <div></div>
          {results.map((r) => (
            <div key={r.method} className="text-center">
              <div className="font-semibold">{r.method}</div>
              <div className="text-xs text-gray-500">{AccountingMethodDisplayNames[r.method]}</div>
            </div>
          ))}
        </div>
        <div className="border-t my-3" />

        <CompRow label="Total Gain/Loss" values={results.map((r) => ({ value: r.totalGL, isBest: r.method === bestMethod.method }))} />
        <CompRow label="Short-term" values={results.map((r) => ({ value: r.stGL }))} />
        <CompRow label="Long-term" values={results.map((r) => ({ value: r.ltGL }))} />
        <div className={`grid grid-cols-2 gap-4 py-2`}>
          <div className="text-gray-500"># Sales</div>
          {results.map((r) => <div key={r.method} className="text-center tabular-nums">{r.salesCount}</div>)}
        </div>
      </div>

      {/* Info */}
      <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg flex items-center gap-3">
        <span className="text-xl">💡</span>
        <span>
          <strong>FIFO</strong> is the IRS default method. To optimize which lots are sold, use <strong>Specific Identification</strong> in the Record Sale view before executing a trade.
        </span>
      </div>
    </div>
  );
}

function CompRow({ label, values }: { label: string; values: { value: number; isBest?: boolean }[] }) {
  return (
    <div className={`grid grid-cols-2 gap-4 py-2`}>
      <div className="text-gray-500">{label}</div>
      {values.map((v, i) => (
        <div key={i} className={`text-center tabular-nums ${v.isBest ? "font-bold" : ""} ${v.value >= 0 ? "text-green-600" : "text-red-500"}`}>
          {v.value >= 0 ? "+" : ""}{formatUSD(v.value)}
        </div>
      ))}
    </div>
  );
}
