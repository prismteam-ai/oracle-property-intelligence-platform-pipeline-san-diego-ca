import { Suspense, lazy, useEffect, useId, useMemo, useState } from 'react';
import { MARKER_COLORS, type MapPoint } from '../components/mapColors';
import { Card, DataTable, ErrorNotice, Loading } from '../components/ui';
import { AgentUnavailableError, askAgent, type AgentRequest } from '../lib/api';
import { AGENT_URL } from '../lib/config';
import { fmtInt } from '../lib/format';
import { MAX_RADIUS_MILES, PLACES, type Place } from '../lib/places';
import type { AgentResponse } from '../lib/schemas';

const MapView = lazy(() => import('../components/MapView'));

export const agedRoofPrompt = (place: Place): string =>
  `Which properties in San Diego County within five miles of ${place.name} have roofs older than 15 years?`;
export const OPEN_PERMIT_PROMPT =
  'Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?';

type State =
  | { status: 'idle' }
  | { status: 'loading'; question: string }
  | { status: 'unavailable'; question: string }
  | { status: 'error'; question: string; error: Error }
  | { status: 'ok'; question: string; response: AgentResponse };

const MAX_ROWS_SHOWN = 200;

function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="muted"> {seconds} s</span>;
}

function Answer({
  response,
  place,
  radius,
}: {
  response: AgentResponse;
  place: Place;
  radius: number;
}) {
  const points = useMemo<MapPoint[]>(
    () =>
      response.points.map((p) => ({
        id: p.apn,
        lat: p.lat,
        lon: p.lon,
        label: p.label ?? p.apn,
        color: MARKER_COLORS.agent,
      })),
    [response.points],
  );
  const columns = columnsOf(response.rows);
  return (
    <div className="stack" data-testid="agent-result">
      <section aria-label="Answer">
        <h4>Answer</h4>
        <p className="agent-text" data-testid="agent-answer">
          {response.answer}
        </p>
        <p className="muted small" data-testid="agent-meta">
          {response.model ? `Model ${response.model}` : 'Model not reported'}
          {response.elapsedMs !== null && response.elapsedMs !== undefined
            ? ` · ${(response.elapsedMs / 1000).toFixed(1)} s`
            : ''}
        </p>
      </section>

      <section aria-label="Assumptions and missing data">
        <h4>Assumptions and missing data</h4>
        {response.assumptions.length === 0 ? (
          <p className="empty-line">The agent stated no assumptions.</p>
        ) : (
          <ul className="bullets" data-testid="agent-assumptions">
            {response.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Evidence">
        <h4>Evidence: the tool calls behind the answer</h4>
        {response.evidence.length === 0 ? (
          <p className="empty-line">The agent reported no tool calls.</p>
        ) : (
          <ol className="evidence" data-testid="agent-evidence">
            {response.evidence.map((e, i) => (
              <li key={`${e.tool}-${i}`}>
                <strong>
                  <code>{e.tool}</code>
                </strong>
                {e.rowCount !== null && e.rowCount !== undefined
                  ? ` · ${fmtInt(e.rowCount)} rows`
                  : ''}
                {e.note ? <span className="muted"> · {e.note}</span> : null}
                {e.sql ? <pre className="code">{e.sql}</pre> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Rows">
        <h4>Rows ({fmtInt(response.rows.length)})</h4>
        {response.rows.length === 0 ? (
          <p className="empty-line" data-testid="agent-rows-empty">
            The agent returned no rows for this question.
          </p>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={response.rows.slice(0, MAX_ROWS_SHOWN)}
              testId="agent-rows"
              caption="Rows returned by the agent"
            />
            {response.rows.length > MAX_ROWS_SHOWN ? (
              <p className="muted small">Showing the first {MAX_ROWS_SHOWN} rows.</p>
            ) : null}
          </>
        )}
      </section>

      <section aria-label="Map of the answer">
        <h4>On the map ({fmtInt(points.length)} points)</h4>
        {points.length === 0 ? (
          <p className="empty-line">The answer has no plottable points.</p>
        ) : (
          <div className="map-box map-box-short">
            <Suspense fallback={<Loading label="Loading the map…" />}>
              <MapView
                testId="agent-map"
                ariaLabel="Map of the properties in the agent's answer"
                pin={place}
                radiusMiles={radius}
                points={points}
              />
            </Suspense>
          </div>
        )}
      </section>
    </div>
  );
}

export default function AgentPanel({
  ask = askAgent,
}: {
  ask?: (request: AgentRequest) => Promise<AgentResponse>;
}) {
  const [placeId, setPlaceId] = useState(PLACES[0]?.id ?? '');
  const [radius, setRadius] = useState('5');
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const ids = useId();
  const place = PLACES.find((p) => p.id === placeId) ?? (PLACES[0] as Place);
  const radiusMiles = Math.min(MAX_RADIUS_MILES, Math.max(0.1, Number(radius) || 5));

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '' || state.status === 'loading') return;
    setState({ status: 'loading', question: trimmed });
    ask({ question: trimmed, center: { lat: place.lat, lon: place.lon }, radiusMiles }).then(
      (response) => setState({ status: 'ok', question: trimmed, response }),
      (error: unknown) => {
        if (error instanceof AgentUnavailableError) {
          setState({ status: 'unavailable', question: trimmed });
        } else {
          setState({
            status: 'error',
            question: trimmed,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
  };

  const examples = [
    { id: 'aged-roofs', text: agedRoofPrompt(place) },
    { id: 'open-permits', text: OPEN_PERMIT_PROMPT },
  ];
  const busy = state.status === 'loading';

  return (
    <div className="page" data-testid="section-agent">
      <div className="page-head">
        <div>
          <h2>Ask the agent</h2>
          <p className="muted">
            The agent answers with the same read-only tools shown on the MCP page, and reports the
            calls it made so every answer can be checked.
          </p>
        </div>
      </div>

      <Card title="Question" testId="card-agent-form">
        <div className="controls-row">
          <label className="field">
            <span className="field-label">Place (fills “[city xyz]” and anchors “that area”)</span>
            <select
              data-testid="agent-place"
              value={placeId}
              onChange={(e) => setPlaceId(e.target.value)}
            >
              {PLACES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-narrow">
            <span className="field-label">Radius (miles)</span>
            <input
              type="number"
              min={0.1}
              max={MAX_RADIUS_MILES}
              step={0.5}
              data-testid="agent-radius"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
          </label>
        </div>

        <div className="examples">
          <p className="field-label" id={`${ids}-examples`}>
            Demo prompts (one click asks)
          </p>
          <ul aria-labelledby={`${ids}-examples`}>
            {examples.map((example) => (
              <li key={example.id}>
                <button
                  type="button"
                  className="example"
                  data-testid={`agent-example-${example.id}`}
                  disabled={busy}
                  onClick={() => {
                    setQuestion(example.text);
                    submit(example.text);
                  }}
                >
                  {example.text}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <form
          className="stack-tight"
          onSubmit={(event) => {
            event.preventDefault();
            submit(question);
          }}
        >
          <label className="field-label" htmlFor={`${ids}-question`}>
            Or ask your own question
          </label>
          <textarea
            id={`${ids}-question`}
            rows={3}
            maxLength={600}
            data-testid="agent-question"
            placeholder="e.g. Which roofing contractors hold the most open permits near La Jolla?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="agent-ask"
              disabled={busy || question.trim() === ''}
            >
              Ask the agent
            </button>
            <span className="muted small">
              Sent with centre {place.lat}, {place.lon} and radius {radiusMiles} mi.
            </span>
          </div>
        </form>
      </Card>

      <Card title="Answer" testId="card-agent-answer">
        <div aria-live="polite" className="stack-tight">
          {state.status !== 'idle' ? (
            <p className="agent-asked" data-testid="agent-asked">
              {state.question}
            </p>
          ) : null}
          {state.status === 'idle' ? (
            <p className="empty-line" data-testid="agent-idle">
              Pick a demo prompt or ask a question. The answer, its assumptions, the tool calls and
              the rows appear here.
            </p>
          ) : null}
          {state.status === 'loading' ? (
            <div data-testid="agent-loading">
              <Loading label="The agent is querying the data… this usually takes 10 to 30 seconds." />
              <Elapsed />
            </div>
          ) : null}
          {state.status === 'unavailable' ? (
            <div className="notice notice-warn" role="status" data-testid="agent-unavailable">
              <div className="notice-body">
                <strong>The agent endpoint is not available yet.</strong>
                <p>
                  <code>POST {AGENT_URL}</code> answered 404, so it has not been deployed on this
                  API. The same questions can be answered now on the Explore map and in the query
                  layer, which use the tools the agent will call.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => submit(state.question)}
              >
                Try again
              </button>
            </div>
          ) : null}
          {state.status === 'error' ? (
            <ErrorNotice
              error={state.error}
              onRetry={() => submit(state.question)}
              testId="agent-error"
            />
          ) : null}
          {state.status === 'ok' ? (
            <Answer response={state.response} place={place} radius={radiusMiles} />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
