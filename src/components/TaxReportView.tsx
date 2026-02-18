import { useMemo, useState, useEffect } from "react";
import { useAppState } from "../lib/app-state";
import { calculate } from "../lib/cost-basis";
import { exportForm8949CSV, exportLegacyCSV, exportTurboTaxTXF, exportTurboTaxCSV, exportForm8283CSV, buildDonationSummary } from "../lib/export";
import { exportForm8949PDF } from "../lib/pdf-export";
import { formatUSD, formatBTC, formatDate } from "../lib/utils";
import { AccountingMethod } from "../lib/types";
import { computeCarryforward } from "../lib/carryforward";
import { HelpPanel } from "./HelpPanel";

export function TaxReportView() {
  const { allTransactions, recordedSales, selectedYear, setSelectedYear, selectedMethod, setSelectedMethod, availableYears } = useAppState();

  const result = useMemo(() => calculate(allTransactions, selectedMethod, recordedSales), [allTransactions, selectedMethod, recordedSales]);

  // Filter sales to selected year — calculate() now handles Specific ID natively
  // (recorded lot elections are respected during engine replay, no overlay needed)
  const salesForYear = useMemo(() => {
    return result.sales.filter((s) => new Date(s.saleDate).getFullYear() === selectedYear);
  }, [result.sales, selectedYear]);

  // Exclude donations from all summary totals and ST/LT breakdown:
  // - Donations have zero proceeds/gainLoss but retain costBasis (proceeds - costBasis ≠ totalGL)
  // - Donations have salePricePerBTC=0 which would produce phantom losses in the lot-detail formula
  const taxableSales = salesForYear.filter((s) => !s.isDonation);
  const totalProceeds = taxableSales.reduce((a, s) => a + s.totalProceeds, 0);
  const totalCostBasis = taxableSales.reduce((a, s) => a + s.costBasis, 0);
  const totalGL = taxableSales.reduce((a, s) => a + s.gainLoss, 0);

  // Compute ST/LT gain/loss from lot details, not sale-level isLongTerm (handles mixed-term sales)
  const stGL = taxableSales.reduce((a, s) => {
    return a + s.lotDetails.filter((d) => !d.isLongTerm).reduce((sum, d) => sum + (d.amountBTC * s.salePricePerBTC - d.totalCost), 0);
  }, 0);
  const ltGL = taxableSales.reduce((a, s) => {
    return a + s.lotDetails.filter((d) => d.isLongTerm).reduce((sum, d) => sum + (d.amountBTC * s.salePricePerBTC - d.totalCost), 0);
  }, 0);

  // Donation summary for Form 8283 reference card
  const donationSummary = useMemo(() => {
    const donationsForYear = salesForYear.filter((s) => s.isDonation);
    return donationsForYear.length > 0 ? buildDonationSummary(donationsForYear, allTransactions, selectedYear) : [];
  }, [salesForYear, allTransactions, selectedYear]);

  const [exportToast, setExportToast] = useState<string | null>(null);

  useEffect(() => {
    if (!exportToast) return;
    const timer = setTimeout(() => setExportToast(null), 3000);
    return () => clearTimeout(timer);
  }, [exportToast]);

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setExportToast(filename);
  };

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-3xl font-bold mb-1">Tax Report</h1>
      <HelpPanel
        subtitle="Form 8949 and Schedule D data for your selected tax year and accounting method."
        expandedContent={
          <>
            <p><strong>Short-term vs. long-term:</strong> Assets held one year or less are short-term (taxed as ordinary income). Assets held more than one year are long-term (lower capital gains rate).</p>
            <p><strong>Accounting methods:</strong> FIFO sells oldest lots first, LIFO sells newest, HIFO sells highest-cost. Specific ID lets you choose individual lots.</p>
            <p><strong>Export options:</strong> Form 8949 CSV for manual filing, TurboTax CSV/TXF for direct import, or a PDF summary for your records.</p>
          </>
        }
      />

      {/* Controls */}
      <div className="flex items-center gap-6 mb-6">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Tax Year:</span>
          <select className="select" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
            {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="segmented">
          {Object.values(AccountingMethod).map((m) => (
            <button key={m} className={`segmented-btn ${selectedMethod === m ? "active" : ""}`} onClick={() => setSelectedMethod(m)}>{m}</button>
          ))}
        </div>
      </div>

      {salesForYear.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-5xl mb-4 opacity-50">📄</div>
          <h2 className="text-xl text-gray-500">No sales in {selectedYear}</h2>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="card mb-6">
            <h3 className="font-semibold mb-3">Summary — {selectedYear} ({selectedMethod})</h3>
            <div className="grid grid-cols-5 gap-4">
              <div><div className="text-xs text-gray-500">Total Proceeds</div><div className="font-semibold tabular-nums">{formatUSD(totalProceeds)}</div></div>
              <div><div className="text-xs text-gray-500">Cost Basis</div><div className="font-semibold tabular-nums">{formatUSD(totalCostBasis)}</div></div>
              <div><div className="text-xs text-gray-500">Total Gain/Loss</div><div className={`font-semibold tabular-nums ${totalGL >= 0 ? "text-green-600" : "text-red-500"}`}>{formatUSD(totalGL)}</div></div>
              <div><div className="text-xs text-gray-500">Short-term</div><div className={`font-semibold tabular-nums ${stGL >= 0 ? "text-green-600" : "text-red-500"}`}>{formatUSD(stGL)}</div></div>
              <div><div className="text-xs text-gray-500">Long-term</div><div className={`font-semibold tabular-nums ${ltGL >= 0 ? "text-green-600" : "text-red-500"}`}>{formatUSD(ltGL)}</div></div>
            </div>
          </div>

          {/* Capital Loss Carryforward Info */}
          {(() => {
            const cf = computeCarryforward(stGL, ltGL);
            if (cf.netGainLoss >= 0) return null;
            return (
              <div className="card mb-6 border-l-4 border-l-orange-500">
                <h3 className="font-semibold mb-2">Capital Loss Carryforward</h3>
                <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                  <p>Your net capital loss of <span className="font-medium text-red-500">{formatUSD(cf.netGainLoss)}</span> exceeds the <span className="font-medium">{formatUSD(-3000)}</span> annual deduction limit.</p>
                  {cf.carryforwardAmount < 0 && (
                    <p>You may deduct <span className="font-medium">{formatUSD(cf.deductibleLoss)}</span> this year and carry forward <span className="font-medium text-orange-500">{formatUSD(cf.carryforwardAmount)}</span> to future tax years.</p>
                  )}
                  <p className="text-xs text-gray-500 mt-2">
                    If you have capital loss carryforward from prior years, consult IRS Form 1040 Schedule D instructions.
                    This calculation does not include prior-year carryforward amounts.
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Charitable Donations — Form 8283 Reference */}
          {donationSummary.length > 0 && (
            <div className="card mb-6 border-l-4 border-l-purple-500">
              <h3 className="font-semibold mb-1">Charitable Donations — Form 8283 Reference</h3>
              <p className="text-xs text-gray-500 mb-4">
                Noncash charitable contributions are reported on IRS Form 8283 (Schedule A), not Form 8949.
                This data is for your records when preparing that form.
              </p>

              {/* Donation summary stats */}
              <div className="grid grid-cols-4 gap-4 mb-4">
                <div>
                  <div className="text-xs text-gray-500">Total Donated</div>
                  <div className="font-semibold tabular-nums">{formatBTC(donationSummary.reduce((a, d) => a + d.amountBTC, 0))} BTC</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Fair Market Value</div>
                  <div className="font-semibold tabular-nums text-purple-600">{formatUSD(donationSummary.reduce((a, d) => a + d.totalFMV, 0))}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Cost Basis</div>
                  <div className="font-semibold tabular-nums">{formatUSD(donationSummary.reduce((a, d) => a + d.costBasis, 0))}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Donations</div>
                  <div className="font-semibold">{donationSummary.length}</div>
                </div>
              </div>

              {/* Per-donation detail */}
              {donationSummary.map((d, idx) => (
                <details key={idx} className="mb-2">
                  <summary className="flex items-center gap-3 py-2 px-3 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800">
                    <span className="font-medium">Donation #{idx + 1}</span>
                    <span className="text-gray-500 text-sm">{formatDate(d.date)}</span>
                    <span className="flex-1" />
                    <span className="tabular-nums text-sm">{formatBTC(d.amountBTC)} BTC</span>
                    {d.fmvPerBTC > 0 && (
                      <span className="tabular-nums text-sm text-purple-600">FMV {formatUSD(d.totalFMV)}</span>
                    )}
                    <span className={`badge ${d.holdingPeriod === "Long-term" ? "badge-green" : d.holdingPeriod === "Mixed" ? "badge-blue" : "badge-orange"}`}>
                      {d.holdingPeriod}
                    </span>
                  </summary>
                  <div className="ml-8 mt-1 text-xs space-y-1">
                    <div className="flex gap-4 text-gray-600 dark:text-gray-400">
                      <span>Exchange: {d.exchange}</span>
                      {d.notes && <span>Notes: {d.notes}</span>}
                    </div>
                    <div className="flex gap-4 text-gray-600 dark:text-gray-400">
                      <span>Cost Basis: {formatUSD(d.costBasis)}</span>
                      {d.fmvPerBTC > 0 && <span>FMV/BTC: {formatUSD(d.fmvPerBTC)}</span>}
                    </div>
                    {d.lotDetails.map((lot, li) => (
                      <div key={li} className="flex gap-4 py-0.5 text-gray-500">
                        <span>Acquired {formatDate(lot.purchaseDate)}</span>
                        <span className="tabular-nums">{formatBTC(lot.amountBTC)} BTC</span>
                        <span className="tabular-nums">basis {formatUSD(lot.costBasis)}</span>
                        <span className={lot.isLongTerm ? "text-green-600" : "text-orange-500"}>{lot.isLongTerm ? "Long" : "Short"}</span>
                      </div>
                    ))}
                    <div className="text-xs text-gray-400 mt-1">
                      {d.holdingPeriod === "Long-term"
                        ? "Held > 1 year — deductible at FMV (IRC §170(b)(1)(C)), limited to 30% of AGI"
                        : d.holdingPeriod === "Short-term"
                          ? "Held ≤ 1 year — deductible at cost basis only (IRC §170(e)(1)(A))"
                          : "Mixed holding periods — long-term portion deductible at FMV, short-term at cost basis"
                      }
                    </div>
                  </div>
                </details>
              ))}

              {/* Form 8283 Export */}
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                <button
                  className="btn-secondary text-sm"
                  onClick={() => downloadCSV(
                    exportForm8283CSV(donationSummary, selectedYear),
                    `form_8283_donations_${selectedYear}.csv`
                  )}
                >
                  📋 Export Form 8283 CSV
                </button>
                <span className="text-xs text-gray-400 ml-3">Reference data for IRS Form 8283 preparation</span>
              </div>
            </div>
          )}

          {/* Export */}
          <div className="card mb-6">
            <h3 className="font-semibold mb-3">Export Tax Documents</h3>
            <div className="flex gap-3 flex-wrap">
              <button className="btn-secondary" onClick={() => downloadCSV(exportForm8949CSV(salesForYear, selectedYear, selectedMethod), `form_8949_${selectedYear}_${selectedMethod}.csv`)}>
                📊 Form 8949 CSV
              </button>
              <button className="btn-secondary" onClick={() => downloadCSV(exportLegacyCSV(salesForYear), `btc_tax_${selectedYear}_${selectedMethod}.csv`)}>
                📋 Raw Data CSV
              </button>
              <button className="btn-secondary" onClick={() => downloadCSV(exportTurboTaxCSV(salesForYear, selectedYear), `turbotax_${selectedYear}.csv`)}>
                💼 TurboTax CSV
              </button>
              <button className="btn-secondary" onClick={() => downloadCSV(exportTurboTaxTXF(salesForYear, selectedYear), `turbotax_${selectedYear}.txf`)}>
                📑 TurboTax TXF
              </button>
              <button className="btn-secondary" onClick={() => { exportForm8949PDF(salesForYear, selectedYear, selectedMethod); setExportToast(`form_8949_${selectedYear}_${selectedMethod}.pdf`); }}>
                📄 PDF Report
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Form 8949 exports include Part I (short-term) and Part II (long-term) separated sections with Schedule D summary.
              TurboTax formats can be imported directly into TurboTax.
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Note: If your modified adjusted gross income exceeds $200,000 ($250,000 MFJ),
              capital gains may be subject to an additional 3.8% Net Investment Income Tax (NIIT).
              Consult IRS Form 8960 or a tax professional.
            </p>
          </div>

          {/* Sales List */}
          <div className="card">
            <h3 className="font-semibold mb-3">
              Dispositions ({salesForYear.length})
              {salesForYear.some((s) => s.isDonation) && (
                <span className="text-sm font-normal text-gray-500 ml-2">
                  {salesForYear.filter((s) => !s.isDonation).length} sales, {salesForYear.filter((s) => s.isDonation).length} donations
                </span>
              )}
            </h3>
            {salesForYear.map((sale, idx) => (
              <details key={sale.id} className="mb-2">
                <summary className="flex items-center gap-3 py-2 px-3 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800">
                  <span className="font-medium">{sale.isDonation ? "Donation" : "Sale"} #{idx + 1}</span>
                  <span className="text-gray-500 text-sm">{formatDate(sale.saleDate)}</span>
                  <span className="flex-1" />
                  <span className="tabular-nums text-sm">{formatBTC(sale.amountSold)} BTC</span>
                  <span className={`font-medium tabular-nums ${sale.gainLoss >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {sale.gainLoss >= 0 ? "+" : ""}{formatUSD(sale.gainLoss)}
                  </span>
                  {sale.isDonation ? (
                    <span className="badge" style={{ background: "rgba(168,85,247,0.15)", color: "#a855f7" }}>Donation</span>
                  ) : sale.isMixedTerm ? (
                    <span className="badge badge-blue">Mixed</span>
                  ) : (
                    <span className={`badge ${sale.isLongTerm ? "badge-green" : "badge-orange"}`}>
                      {sale.isLongTerm ? "Long-term" : "Short-term"}
                    </span>
                  )}
                </summary>
                <div className="ml-8 mt-1 text-xs">
                  {sale.lotDetails.map((d) => (
                    <div key={d.id} className="flex gap-4 py-1 text-gray-600 dark:text-gray-400">
                      <span>{formatDate(d.purchaseDate)}</span>
                      <span className="tabular-nums">{formatBTC(d.amountBTC)} BTC</span>
                      <span className="tabular-nums">@{formatUSD(d.costBasisPerBTC)}</span>
                      <span>{d.daysHeld} days</span>
                      <span className={d.isLongTerm ? "text-green-600" : "text-orange-500"}>{d.isLongTerm ? "Long" : "Short"}</span>
                      <span>{d.exchange}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </>
      )}

      {/* Export toast notification */}
      {exportToast && (
        <div className="fixed bottom-6 right-6 bg-green-600 text-white px-5 py-3 rounded-lg shadow-lg flex items-center gap-3 z-50 animate-fade-in">
          <span className="text-lg">✓</span>
          <div>
            <div className="font-medium text-sm">Export Complete</div>
            <div className="text-xs opacity-90">{exportToast}</div>
          </div>
        </div>
      )}
    </div>
  );
}
