/**
 * Math + mermaid fixture (dev only): what `/dev/math` renders through the
 * thread markdown, and what tests/components/math-mermaid-fixture.test.tsx
 * renders in the DOM. Covers the cases a KaTeX or mermaid upgrade can break:
 * inline and display math, a matrix, a flowchart and a sequence diagram.
 */
export const MATH_MERMAID_FIXTURE = String.raw`## Inline math

Euler: $e^{i\pi} + 1 = 0$, and a fraction inline $\frac{a+b}{2} \geq \sqrt{ab}$.

## Display math

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

## Matrix

$$
A = \begin{pmatrix} 1 & 2 & 3 \\ 4 & 5 & 6 \\ 7 & 8 & 9 \end{pmatrix},\qquad
\det\begin{bmatrix} a & b \\ c & d \end{bmatrix} = ad - bc
$$

## Flowchart

` + "```mermaid" + String.raw`
flowchart LR
  A[Message] --> B{Has math?}
  B -- yes --> C[KaTeX]
  B -- no --> D[Plain text]
  C --> E[Thread]
  D --> E
` + "```" + String.raw`

## Sequence diagram

` + "```mermaid" + String.raw`
sequenceDiagram
  participant U as User
  participant C as Console
  participant A as API
  U->>C: send a message
  C->>A: POST /api/messages
  A-->>C: streamed answer
  C-->>U: rendered math and diagrams
` + "```" + "\n";
