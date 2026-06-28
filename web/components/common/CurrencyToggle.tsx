"use client";

const CURRENCIES = ["USD", "KRW", "CNY", "EUR", "JPY", "SGD"];

export default function CurrencyToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value || "USD";
  return (
    <div className="seg-tabs currency-toggle">
      {CURRENCIES.map((currency) => (
        <button
          key={currency}
          type="button"
          className={selected === currency ? "on" : ""}
          onClick={() => onChange(currency)}
        >
          {currency}
        </button>
      ))}
    </div>
  );
}
