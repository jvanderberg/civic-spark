import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./project-brief.css";

export function ProjectBrief({ markdown }: { markdown: string }) {
  const compact = markdown.length > 600 || markdown.split("\n").length > 12;
  const content = (
    <div className="project-brief-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Follow the chat renderer: untrusted images never load automatically.
          img: ({ alt }) => <span>{alt ? `Image: ${alt}` : "Image"}</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide code.
            <pre tabIndex={0}>{children}</pre>
          ),
          table: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
            <section className="project-brief-table" aria-label="Table" tabIndex={0}>
              <table>{children}</table>
            </section>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
  return compact ? (
    <details className="project-brief">
      <summary>Read project brief</summary>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded region needs keyboard scrolling. */}
      <section className="project-brief-scroll" aria-label="Project brief" tabIndex={0}>
        {content}
      </section>
    </details>
  ) : (
    <section className="project-brief" aria-label="Project brief">
      {content}
    </section>
  );
}
