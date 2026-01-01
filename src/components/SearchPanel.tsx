import { useEffect, useRef } from "react";
import type { SearchEntry } from "../types/search";

type SearchPanelProps = {
  open: boolean;
  query: string;
  results: SearchEntry[];
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onResultClick?: (result: SearchEntry) => void;
  loading?: boolean;
};

const SearchPanel = ({
  open,
  query,
  results,
  onQueryChange,
  onClose,
  onResultClick,
  loading = false
}: SearchPanelProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const trimmedQuery = query.trim();

  return (
    <>
      <div className="search-backdrop" onClick={onClose} />
      <aside
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search posts, authors, and relays"
        aria-busy={loading}
      >
        <div className="search-panel-header">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search names, events, titles, npubs..."
            aria-label="Search content"
          />
          <div className={`search-panel-spinner ${loading ? "visible" : ""}`} aria-hidden="true">
            <span />
          </div>
          <button type="button" className="ghost-pill" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="search-panel-body">
          {loading && (
            <p className="search-loading">Querying relays…</p>
          )}
          {!loading && trimmedQuery && !results.length ? (
            <p className="search-empty">
              No matches yet. Try another name, npub, or keyword.
            </p>
          ) : (
            <>
              {results.length ? (
                results.map((result) => (
                  <a
                    key={`${result.type}-${result.id}`}
                    href={result.link}
                    target="_blank"
                    rel="noreferrer"
                    className="search-item"
                    onClick={() => onResultClick?.(result)}
                  >
                    <div className="search-item-label">
                      <span>{result.label}</span>
                      <small>{result.type === "event" ? "event" : "profile"}</small>
                    </div>
                    {result.description && <p>{result.description}</p>}
                    {result.meta && <span className="search-item-meta">{result.meta}</span>}
                  </a>
                ))
              ) : (
                !loading && (
                  <p className="search-empty">
                    Start typing to explore content from your feeds, authors, and relays.
                  </p>
                )
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
};

export default SearchPanel;
