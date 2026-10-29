import { useMemo, useState } from "react";
import { Badge, TextArea } from "@/components";
import { decodeJwt } from "./jwt.logic";
import { OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

const CLAIM_LABEL = { iat: "Issued at (iat)", nbf: "Not before (nbf)", exp: "Expires (exp)" } as const;

export default function JwtUtil() {
  const [token, setToken] = useState("");
  const debounced = useDebounced(token);
  const r = useMemo(() => {
    if (debounced.trim() === "") return null;
    try {
      return { ok: true as const, jwt: decodeJwt(debounced, Date.now()) };
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : "Couldn't decode" };
    }
  }, [debounced]);

  return (
    <div className={styles.util}>
      <p className={styles.note}>Decoded locally — nothing leaves this computer. The signature is never verified.</p>
      <div className={styles.col}>
        <span className={styles.label}>Token</span>
        <TextArea
          mono
          minRows={4}
          maxRows={10}
          value={token}
          invalid={r?.ok === false}
          onChange={(e) => setToken(e.target.value)}
          aria-label="JWT"
          spellCheck={false}
          placeholder="eyJhbGciOi..."
        />
        {r?.ok === false && <p className={styles.error}>{r.message}</p>}
      </div>
      {r?.ok && (
        <>
          {r.jwt.claims.length > 0 && (
            <table className={styles.table} aria-label="Time claims">
              <tbody>
                {r.jwt.claims.map((c) => (
                  <tr key={c.name}>
                    <th scope="row">{CLAIM_LABEL[c.name]}</th>
                    <td className={styles.mono}>{c.seconds}</td>
                    <td>{c.local}</td>
                    <td>
                      {c.status === "expired" && <Badge tone="danger">Expired</Badge>}
                      {c.status === "not-yet-valid" && <Badge tone="warn">Not yet valid</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className={styles.cols}>
            <OutputBox label="Header" value={r.jwt.headerText} />
            <OutputBox label="Payload" value={r.jwt.payloadText} />
          </div>
          <OutputBox label="Signature (not verified)" value={r.jwt.signature} />
        </>
      )}
    </div>
  );
}
