import { useState, useRef, useEffect } from "react";
import { saveTOSAccepted } from "../lib/persistence";

export function TermsOfService({ onAccepted }: { onAccepted: () => void }) {
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom) setHasScrolledToBottom(true);
    };
    el.addEventListener("scroll", handleScroll);
    // Check if content is short enough to not need scrolling
    if (el.scrollHeight <= el.clientHeight + 40) setHasScrolledToBottom(true);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const handleAccept = () => {
    saveTOSAccepted();
    onAccepted();
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-50 dark:bg-zinc-900 p-6">
      <div className="w-full max-w-2xl flex flex-col" style={{ maxHeight: "90vh" }}>
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">📜</div>
          <h1 className="text-2xl font-bold">Terms of Service</h1>
          <p className="text-gray-500 text-sm mt-1">Please review and accept before continuing</p>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto card text-sm leading-relaxed mb-4"
          style={{ maxHeight: "55vh" }}
        >
          <p className="text-xs text-gray-400 mb-4">Effective Date: February 8, 2026</p>

          <p className="mb-3">These Terms of Service ("Terms") govern your use of the Sovereign Tax desktop application ("Software," "App," or "Product"). By using the Software, you agree to be bound by these Terms. If you do not agree, do not use the Software.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">1. License Grant</h3>
          <p className="mb-2">Upon purchase, we grant you a <strong>non-exclusive, non-transferable, perpetual license</strong> to install and use one copy of the Software on up to <strong>two (2) devices</strong> that you personally own or control.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">2. Nature of the Software</h3>
          <p className="mb-2">Sovereign Tax is a <strong>local, offline desktop application</strong> that runs entirely on your device. The Software does not collect, transmit, or store any of your data on external servers. It does not require an internet connection to function. It encrypts all stored data locally using AES-256-GCM encryption.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">3. Not Tax Advice</h3>
          <p className="mb-2"><strong>The Software is a calculation tool, not a tax advisor.</strong> All calculations, reports, and outputs are for informational purposes only. You are solely responsible for verifying all calculations and tax filings. You should consult a qualified tax professional before making tax decisions based on outputs from the Software.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">4. Accuracy and Data Responsibility</h3>
          <p className="mb-2">We make <strong>no guarantees</strong> that the outputs are error-free or suitable for filing with any tax authority. You are responsible for ensuring all imported data is accurate and complete, and for reviewing all generated reports before filing.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">5. Data Loss and Recovery</h3>
          <p className="mb-2">Because the Software operates entirely offline with local encryption: <strong>we cannot recover your data</strong> if you lose your device, forget your PIN, or fail to create backups. <strong>We cannot reset your PIN.</strong> You are solely responsible for creating and securely storing encrypted backups.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">6. Payment and Refunds</h3>
          <p className="mb-2">Sovereign Tax is sold as a <strong>one-time purchase</strong>. Refund policies are governed by the payment processor's terms.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">7. Disclaimer of Warranties</h3>
          <p className="mb-2 font-semibold uppercase text-xs">The Software is provided "as is" and "as available" without warranties of any kind, either express or implied. We disclaim all warranties, including implied warranties of merchantability, fitness for a particular purpose, accuracy, and non-infringement.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">8. Limitation of Liability</h3>
          <p className="mb-2 font-semibold uppercase text-xs">To the maximum extent permitted by law, Sovereign Tax and its developers shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including errors in tax calculations, penalties assessed by any tax authority, or loss of data. Our total aggregate liability shall not exceed the amount you paid for the Software.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">9. Indemnification</h3>
          <p className="mb-2">You agree to indemnify, defend, and hold harmless Sovereign Tax and its developers from any claims, damages, losses, liabilities, and expenses arising from your use of the Software or your filing of tax returns based on the Software's outputs.</p>

          <h3 className="font-semibold text-base mt-5 mb-2 text-orange-600">10. Governing Law</h3>
          <p className="mb-2">These Terms shall be governed by and construed in accordance with the laws of the United States.</p>

          <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400">
            © 2026 Sovereign Tax. All rights reserved.
          </div>
        </div>

        {!hasScrolledToBottom && (
          <p className="text-center text-xs text-gray-400 mb-3">↓ Scroll to read the full terms</p>
        )}

        <label className="flex items-center gap-3 justify-center mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={!hasScrolledToBottom}
            className="w-4 h-4 accent-orange-500"
          />
          <span className={`text-sm ${hasScrolledToBottom ? "" : "text-gray-400"}`}>
            I have read and agree to the Terms of Service
          </span>
        </label>

        <div className="text-center">
          <button
            className="btn-primary w-48"
            disabled={!agreed}
            style={{ opacity: agreed ? 1 : 0.3 }}
            onClick={handleAccept}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
