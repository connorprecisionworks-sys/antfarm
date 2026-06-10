import ReactMarkdown from "react-markdown";

interface Props {
  content: string;
  className?: string;
}

export function MarkdownView({ content, className = "" }: Props) {
  return (
    <div className={`prose-dark ${className}`}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-zinc-100 mb-3 mt-5 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold text-zinc-200 mb-2 mt-4">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-zinc-300 mb-2 mt-3">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-sm text-zinc-300 mb-3 leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-3 space-y-1 pl-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-3 space-y-1 pl-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-sm text-zinc-300 leading-relaxed">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-100">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
          a: ({ children }) => (
            <span className="text-indigo-400 cursor-default">{children}</span>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-zinc-700 pl-4 my-3 text-zinc-400 italic">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="bg-zinc-800 text-zinc-200 px-1.5 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto mb-3 text-xs font-mono text-zinc-200">
              {children}
            </pre>
          ),
          hr: () => <hr className="border-zinc-800 my-4" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
