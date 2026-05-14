"use client";

import { useState, useRef, useEffect } from "react";
import styles from "./MultiSelect.module.scss";

interface Option {
  value: string;
  label: string;
}

interface Props {
  options: Option[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder: string;
}

export default function MultiSelect({ options, selected, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  const remove = (value: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selected.filter((v) => v !== value));
  };

  const selectedOptions = options.filter((o) => selected.includes(o.value));
  const availableOptions = options.filter((o) => !selected.includes(o.value));

  return (
    <div className={styles.container} ref={ref}>
      <div
        className={`${styles.control} ${open ? styles.open : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className={styles.pills}>
          {selectedOptions.length === 0 ? (
            <span className={styles.placeholder}>{placeholder}</span>
          ) : (
            selectedOptions.map((opt) => (
              <span key={opt.value} className={styles.pill}>
                {opt.label}
                <button
                  type="button"
                  className={styles.remove}
                  onClick={(e) => remove(opt.value, e)}
                  aria-label={`Remove ${opt.label}`}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <span className={styles.arrow}>▾</span>
      </div>

      {open && (
        <div className={styles.dropdown}>
          {availableOptions.length === 0 ? (
            <div className={styles.empty}>All selected</div>
          ) : (
            availableOptions.map((opt) => (
              <div
                key={opt.value}
                className={styles.option}
                onClick={() => toggle(opt.value)}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
