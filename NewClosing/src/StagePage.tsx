import * as React from "react";
import { useState } from "react";

const COLUMN1 = [
  "Plumbing",
  "Lighting",
  "Cabinets",
  "Kitchen Plan",
  "Flooring",
  "Paint",
  "Foreman Selections",
  "Closets",
  "Deposit"
];

const COLUMN2 = [
  "Finance",
  "Deposit",
  "Permit",
  "NL Power"
];

export default function StagePage({
  jobId,
  stages,
  onClose,
  onSave
}: {
  jobId: string;
  stages: { [stage: string]: boolean | string };
  onClose: () => void;
  onSave: (jobId: string, stages: { [stage: string]: boolean | string }) => void;
}) {
  const PASSCODE = "42";
  const [localStages, setLocalStages] = useState<{ [stage: string]: boolean | string }>({
    ...stages,
    PermitNumber: typeof stages.PermitNumber === "string" ? stages.PermitNumber : ""
  });
  // Link state per stage
  const [links, setLinks] = useState<{ [stage: string]: string }>(() => {
    const obj: { [stage: string]: string } = {};
    Object.keys(stages).forEach(k => {
      if (typeof stages[k] === "object" && stages[k]?.link) obj[k] = stages[k].link;
      else obj[k] = "";
    });
    return obj;
  });
  const [showLinkInput, setShowLinkInput] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");

  const unlocked = passcode === PASSCODE;

  const handleChange = (stage: string) => {
    if (!unlocked) return;
    setLocalStages(prev => ({ ...prev, [stage]: !prev[stage] }));
    // Show link input popup if checked
    if (!localStages[stage]) setShowLinkInput(stage);
    else setShowLinkInput(null);
  };

  // Handle link input change
  const handleLinkChange = (stage: string, value: string) => {
    setLinks(prev => ({ ...prev, [stage]: value }));
    // Autosave link
    setLocalStages(prev => ({ ...prev, [`${stage}_link`]: value }));
  };

  // Open link in new tab
  const handleOpenLink = (stage: string) => {
    if (links[stage]) window.open(links[stage], '_blank');
  };
  const handlePermitNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!unlocked) return;
    const value = e.target.value.replace(/\D/g, "").slice(0, 12); // Only digits, max 12
    setLocalStages(prev => ({ ...prev, PermitNumber: value }));
  };

  const handlePasscodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPasscode(e.target.value);
    setError("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlocked) {
      setError("Incorrect passcode.");
      return;
    }
    onSave(jobId, localStages);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900 text-slate-100 min-h-screen w-full">
      <form onSubmit={handleSubmit} className="flex flex-col h-full">
        <div className="flex justify-between items-center p-6 border-b border-slate-700">
          <h2 className="text-2xl font-bold">Track Stages</h2>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-800">Close</button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="mb-6">
            <label className="block text-sm font-medium mb-1 text-slate-200">
              Enter 2-digit passcode to edit:
            </label>
            <input
              type="password"
              value={passcode}
              onChange={handlePasscodeChange}
              maxLength={2}
              className="w-20 rounded bg-slate-700 text-slate-100 px-2 py-1 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
              autoFocus
            />
            {error && <div className="text-red-400 text-xs mt-1">{error}</div>}
          </div>
          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Column 1 */}
            <div className="flex flex-col gap-4">
              {COLUMN1.map(stage => (
                <label key={stage} className="flex items-center gap-2 cursor-pointer relative">
                  <input
                    type="checkbox"
                    checked={!!localStages[stage]}
                    onChange={() => handleChange(stage)}
                    className="accent-sky-500"
                    disabled={!unlocked}
                  />
                  {/* If link exists, show icon and make clickable */}
                  {links[stage] ? (
                    <span
                      className="ml-1 text-sky-400 underline cursor-pointer text-xs"
                      onClick={() => handleOpenLink(stage)}
                      title="Open linked document"
                    >🔗</span>
                  ) : null}
                  <span className={unlocked ? "" : "text-slate-400"}>{stage}</span>
                  {/* Show link input popup if checked and unlocked */}
                  {showLinkInput === stage && unlocked && !!localStages[stage] && (
                    <div className="absolute left-24 top-0 bg-slate-800 border border-slate-600 rounded p-2 flex items-center gap-2 shadow-lg z-10">
                      <input
                        type="text"
                        value={links[stage] || ""}
                        onChange={e => handleLinkChange(stage, e.target.value)}
                        placeholder="Paste link (optional)"
                        className="w-40 px-2 py-1 rounded bg-slate-700 text-slate-100 border border-slate-600 text-xs"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="text-xs px-2 py-1 bg-sky-600 rounded text-white"
                        onClick={() => setShowLinkInput(null)}
                      >Done</button>
                    </div>
                  )}
                </label>
              ))}
            </div>
            {/* Column 2 */}
            <div className="flex flex-col gap-4">
              {COLUMN2.map(stage =>
                stage === "Permit" ? (
                  <label key={stage} className="flex items-center gap-2 cursor-pointer relative">
                    <input
                      type="checkbox"
                      checked={!!localStages[stage]}
                      onChange={() => handleChange(stage)}
                      className="accent-sky-500"
                      disabled={!unlocked}
                    />
                    {links[stage] ? (
                      <span
                        className="ml-1 text-sky-400 underline cursor-pointer text-xs"
                        onClick={() => handleOpenLink(stage)}
                        title="Open linked document"
                      >🔗</span>
                    ) : null}
                    <span className={unlocked ? "" : "text-slate-400"}>{stage}</span>
                    <input
                      type="text"
                      value={localStages.PermitNumber ?? ""}
                      onChange={handlePermitNumberChange}
                      className="ml-2 w-36 rounded bg-slate-700 text-slate-100 px-2 py-1 border border-slate-600"
                      disabled={!unlocked || !localStages[stage]}
                      placeholder="Permit #"
                      maxLength={12}
                    />
                    {showLinkInput === stage && unlocked && !!localStages[stage] && (
                      <div className="absolute left-24 top-0 bg-slate-800 border border-slate-600 rounded p-2 flex items-center gap-2 shadow-lg z-10">
                        <input
                          type="text"
                          value={links[stage] || ""}
                          onChange={e => handleLinkChange(stage, e.target.value)}
                          placeholder="Paste link (optional)"
                          className="w-40 px-2 py-1 rounded bg-slate-700 text-slate-100 border border-slate-600 text-xs"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="text-xs px-2 py-1 bg-sky-600 rounded text-white"
                          onClick={() => setShowLinkInput(null)}
                        >Done</button>
                      </div>
                    )}
                  </label>
                ) : (
                  <label key={stage} className="flex items-center gap-2 cursor-pointer relative">
                    <input
                      type="checkbox"
                      checked={!!localStages[stage]}
                      onChange={() => handleChange(stage)}
                      className="accent-sky-500"
                      disabled={!unlocked}
                    />
                    {/* Add link icon for Deposit, like Change Orders */}
                    {links[stage] ? (
                      <span
                        className="ml-1 text-sky-400 underline cursor-pointer text-xs"
                        onClick={() => handleOpenLink(stage)}
                        title="Open linked document"
                      >🔗</span>
                    ) : null}
                    <span className={unlocked ? "" : "text-slate-400"}>{stage}</span>
                    {/* Show link input popup if checked and unlocked for Deposit */}
                    {showLinkInput === stage && unlocked && !!localStages[stage] && (
                      <div className="absolute left-24 top-0 bg-slate-800 border border-slate-600 rounded p-2 flex items-center gap-2 shadow-lg z-10">
                        <input
                          type="text"
                          value={links[stage] || ""}
                          onChange={e => handleLinkChange(stage, e.target.value)}
                          placeholder="Paste link (optional)"
                          className="w-40 px-2 py-1 rounded bg-slate-700 text-slate-100 border border-slate-600 text-xs"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="text-xs px-2 py-1 bg-sky-600 rounded text-white"
                          onClick={() => setShowLinkInput(null)}
                        >Done</button>
                      </div>
                    )}
                  </label>
                )
              )}
              {/* Two blank lines */}
              <div style={{ height: "2.5rem" }} />
              <div style={{ height: "2.5rem" }} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 p-6 border-t border-slate-700">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-800">Cancel</button>
          <button type="submit" className="px-4 py-2 rounded bg-sky-600 text-white hover:bg-sky-700" disabled={!unlocked}>Save</button>
        </div>
      </form>
    </div>
  );
}