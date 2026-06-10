import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { DayUsage } from "../types";
import { fmtTokens, fmtDollars, formatDate } from "../lib/relativeTime";

interface Props {
  days: DayUsage[];
  weekStart: string;
  weekOnly?: boolean;
}

interface ChartEntry {
  label: string;
  output: number;
  cache_write: number;
  input: number;
  cache_read: number;
  est_dollars: number;
  total: number;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d: ChartEntry = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-zinc-300 font-medium mb-2">{label}</p>
      <div className="space-y-1">
        <Row label="Output" value={fmtTokens(d.output)} color="#818cf8" />
        <Row label="Cache write" value={fmtTokens(d.cache_write)} color="#6d28d9" />
        <Row label="Input" value={fmtTokens(d.input)} color="#4f46e5" />
        <Row label="Cache read" value={fmtTokens(d.cache_read)} color="#374151" />
        <div className="border-t border-zinc-700 my-1.5" />
        <Row label="Total" value={fmtTokens(d.total)} />
        <Row label="Est. cost" value={fmtDollars(d.est_dollars)} />
      </div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-zinc-400">
        {color && (
          <span className="w-2 h-2 rounded-sm inline-block shrink-0" style={{ background: color }} />
        )}
        {label}
      </span>
      <span className="text-zinc-200 font-mono">{value}</span>
    </div>
  );
}

export function TokenChart({ days, weekStart, weekOnly = false }: Props) {
  const filtered = weekOnly ? days.filter((d) => d.date >= weekStart) : days;

  const data: ChartEntry[] = filtered.map((d) => ({
    label: formatDate(d.date),
    output: d.output,
    cache_write: d.cache_write,
    input: d.input,
    cache_read: d.cache_read,
    est_dollars: d.est_dollars,
    total: d.total_tokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="#27272a" strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tick={{ fill: "#71717a", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={fmtTokens}
          tick={{ fill: "#71717a", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={42}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(99,102,241,0.06)" }} />
        <Bar dataKey="output" stackId="a" fill="#6366f1" radius={[0, 0, 0, 0]} name="Output" />
        <Bar dataKey="cache_write" stackId="a" fill="#4338ca" radius={[0, 0, 0, 0]} name="Cache write" />
        <Bar dataKey="input" stackId="a" fill="#3730a3" radius={[3, 3, 0, 0]} name="Input" />
      </BarChart>
    </ResponsiveContainer>
  );
}
