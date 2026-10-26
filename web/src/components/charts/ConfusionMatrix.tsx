'use client';

// Sequential blue ramp, light to dark; a cell's step is its share of the gold row.
const RAMP = ['#f0f6fe', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];

function cellColor(share: number): {background: string; color: string} {
  const step = Math.min(RAMP.length - 1, Math.round(share * (RAMP.length - 1)));
  return {background: RAMP[step], color: step >= 4 ? '#ffffff' : 'var(--color-text-primary)'};
}

/**
 * Rows are gold labels, columns predictions, plus an "invalid" column for outputs
 * that failed schema validation. Shading is the share of the row, so recall reads
 * along the diagonal.
 */
export function ConfusionMatrix({
  labels,
  matrix,
  invalid,
  goldHeading,
  predictedHeading,
  invalidHeading,
  caption,
}: {
  labels: string[];
  matrix: number[][];
  invalid: number[];
  goldHeading: string;
  predictedHeading: string;
  invalidHeading: string;
  caption: string;
}) {
  return (
    <figure className="viz" aria-label={caption}>
      <div className="cm-scroll">
        <table className="cm">
          <thead>
            <tr>
              <th className="cm-corner">
                {goldHeading} ↓ / {predictedHeading} →
              </th>
              {labels.map(l => (
                <th key={l} scope="col">
                  {l}
                </th>
              ))}
              <th scope="col">{invalidHeading}</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => {
              const rowTotal = row.reduce((a, b) => a + b, 0) + invalid[i];
              return (
                <tr key={labels[i]}>
                  <th scope="row">{labels[i]}</th>
                  {row.map((count, j) => (
                    // A native title: a tooltip wrapper element is not valid inside a table row.
                    <td
                      key={j}
                      className={i === j ? 'cm-diag' : undefined}
                      style={cellColor(count / rowTotal)}
                      title={`${labels[i]} → ${labels[j]}: ${count} (${Math.round((count / rowTotal) * 100)}%)`}>
                      {count}
                    </td>
                  ))}
                  <td className="cm-invalid">{invalid[i]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <figcaption className="viz-caption">{caption}</figcaption>
    </figure>
  );
}
