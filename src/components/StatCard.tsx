interface Props {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}

export function StatCard({ label, value, sub, accent }: Props) {
  return (
    <div className={`rounded-xl p-4 border ${accent ? "border-indigo-700/40 bg-indigo-950/30" : "border-zinc-800 bg-surface-2"}`}>
      <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-semibold leading-none ${accent ? "text-indigo-300" : "text-zinc-100"}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}
