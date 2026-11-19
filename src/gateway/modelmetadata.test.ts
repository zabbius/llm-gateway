/**
 * Model-metadata detector contracts — the port of the c0wrk detector-chain
 * tests (`core/modelmetadata_detectors_test.go`): LM Studio window
 * precedence and the max_model_len shield, the aggregator's
 * partial-inherits / full-emits capability gate and contradictory-output
 * normalization, the OpenAI-standard first-non-zero priority, and the
 * chain's first-wins order with unmatched shapes declining to `undefined`.
 */
import { describe, expect, test } from "bun:test";
import {
  aggregatorDeclaresAttachment,
  detectAggregatorMetadata,
  detectLmStudioMetadata,
  detectModelMetadata,
  detectOpenAIStandardMetadata,
  type ModelMetadata,
} from "./modelmetadata.ts";

/** Parses one raw listing entry the way the chain's caller would. */
function parse(entry: string): Record<string, unknown> {
  return JSON.parse(entry) as Record<string, unknown>;
}

/** Runs the chain on one raw listing entry. */
function mustDetect(entry: string): ModelMetadata | undefined {
  return detectModelMetadata(parse(entry));
}

// The real-world aggregator /models listing entry shape (limit/capabilities/
// modalities objects) the aggregator detector targets.
const aggregatorListingEntry = `{
	"id": "opencode/deepseek-v4.1-flash-free",
	"object": "model",
	"created": 1792195200,
	"owned_by": "opencode",
	"type": "chat",
	"name": "DeepSeek V4.1 Flash Free",
	"description": "October 17 update of DeepSeek V4.1 Flash with improved reasoning, coding, agentic tasks, and visual understanding",
	"open_weights": true,
	"modalities": {
		"input": [
			"text",
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp"
		],
		"output": [
			"text"
		]
	},
	"capabilities": {
		"tools": {
			"supported": true
		},
		"reasoning": {
			"supported": true,
			"toggle": true,
			"effort": [
				"low",
				"high",
				"max"
			]
		},
		"structured_output": true,
		"temperature": true,
		"top_p": true,
		"top_k": true,
		"system_updates": true,
		"effort_updates": false
	},
	"limit": {
		"context": 200000,
		"output": 32000
	}
}`;

describe("detectAggregatorMetadata", () => {
  test("full declaration emits authoritative capabilities", () => {
    // The full aggregator shape declares every capability dimension
    // (capabilities + modalities) → an authoritative set, windows verbatim.
    const meta = mustDetect(aggregatorListingEntry);
    expect(meta).toEqual({
      contextWindow: 200000,
      outputLimit: 32000, // the real limit, not the window/4 heuristic
      capabilities: { attachment: true, reasoning: true, temperature: true, toolCall: true },
    });
  });

  test("capabilities without modalities is a partial declaration — inherits", () => {
    // capabilities present, modalities absent → partial → no capabilities
    // (inherit): nothing may be disabled by omission.
    const meta = mustDetect(`{"id":"m","capabilities":{"tools":{"supported":true}},"limit":{"context":100000,"output":16000}}`);
    expect(meta?.contextWindow).toBe(100000);
    expect(meta?.outputLimit).toBe(16000);
    expect(meta?.capabilities).toBeUndefined();
  });

  test("modalities without capabilities is a partial declaration — inherits", () => {
    const meta = mustDetect(`{"id":"m","modalities":{"input":["text","image/png"]},"limit":{"context":100000}}`);
    expect(meta?.capabilities).toBeUndefined();
    expect(meta?.outputLimit).toBe(0); // absent → undeclared
  });

  test("text-only modalities under a full declaration are authoritative", () => {
    // modalities PRESENT declaring text-only input, with the capabilities
    // block carrying the tools/reasoning sub-objects, is a genuine
    // text-only declaration → Attachment false, authoritative.
    const meta = mustDetect(
      `{"id":"m","modalities":{"input":["text"]},"capabilities":{"tools":{"supported":true},"reasoning":{"supported":true},"temperature":true},"limit":{"context":8192}}`,
    );
    expect(meta?.capabilities?.attachment).toBe(false);
  });

  test("sparse capabilities inherit — sub-objects missing either way", () => {
    // A capabilities block WITHOUT the tools/reasoning sub-objects is
    // sparse, not silent: emitting an authoritative set would turn the
    // omission of tools/reasoning into an authoritative false and disable
    // tool routing for a capable model. Windows are still written.
    const meta = mustDetect(`{"id":"m","capabilities":{"temperature":true},"modalities":{"input":["text"]},"limit":{"context":128000,"output":8192}}`);
    expect(meta?.contextWindow).toBe(128000);
    expect(meta?.outputLimit).toBe(8192);
    expect(meta?.capabilities).toBeUndefined();

    // Either sub-object missing alone is also partial.
    const half = mustDetect(
      `{"id":"m","capabilities":{"tools":{"supported":true},"temperature":true},"modalities":{"input":["text"]},"limit":{"context":8192}}`,
    );
    expect(half?.capabilities).toBeUndefined();
  });

  test("temperature omission inherits; explicit false declares; null inherits", () => {
    // A full structural declaration WITHOUT the temperature key is partial:
    // the omission must not become an authoritative Temperature=false.
    let meta = mustDetect(
      `{"id":"m","modalities":{"input":["text"]},"capabilities":{"tools":{"supported":true},"reasoning":{"supported":true}},"limit":{"context":8192}}`,
    );
    expect(meta?.capabilities).toBeUndefined();
    expect(meta?.contextWindow).toBe(8192); // windows still written

    // An explicit temperature:false is a genuine declaration.
    meta = mustDetect(
      `{"id":"m","modalities":{"input":["text"]},"capabilities":{"tools":{"supported":true},"reasoning":{"supported":false},"temperature":false},"limit":{"context":8192}}`,
    );
    expect(meta?.capabilities).toEqual({ attachment: false, reasoning: false, temperature: false, toolCall: true });

    // An explicit null expresses no value → undeclared (inherit).
    meta = mustDetect(
      `{"id":"m","modalities":{"input":["text"]},"capabilities":{"tools":{"supported":true},"reasoning":{"supported":true},"temperature":null},"limit":{"context":8192}}`,
    );
    expect(meta?.capabilities).toBeUndefined();
  });

  test("contradictory and non-positive output normalizes to 0", () => {
    // Output >= context drives EffectiveMax to zero or negative and would
    // silently disable compaction — contradictory listing data is treated
    // as undeclared, the same stance as the non-positive case.
    for (const [entry, want] of [
      [`{"id":"m","limit":{"context":8192,"output":32768}}`, 0], // contradictory → undeclared
      [`{"id":"m","limit":{"context":8192,"output":8192}}`, 0], // equal → contradictory → undeclared
      [`{"id":"m","limit":{"context":8192,"output":4096}}`, 4096], // below → unchanged
      [`{"id":"m","limit":{"context":8192}}`, 0], // absent → undeclared
      [`{"id":"m","limit":{"context":8192,"output":-5}}`, 0], // negative → undeclared
    ] as const) {
      const meta = mustDetect(entry);
      expect(meta?.contextWindow).toBe(8192);
      expect(meta?.outputLimit).toBe(want);
    }
  });

  test("no limit block or non-positive context does not match", () => {
    // The limit block with a positive context is the shape's defining key;
    // without it (or with a non-positive context) the detector declines
    // and the chain continues.
    for (const entry of [
      `{"id":"m","modalities":{"input":["text"]}}`,
      `{"id":"m","limit":{"context":0,"output":4096}}`,
      `{"id":"m","limit":{"context":-5,"output":4096}}`,
      `{"id":"m","limit":{"output":4096}}`,
    ]) {
      expect(detectAggregatorMetadata(parse(entry))).toBeUndefined();
      expect(mustDetect(entry)).toBeUndefined();
    }
  });
});

describe("detectLmStudioMetadata", () => {
  test("loaded_instances beats loaded_context_length beats capacity", () => {
    // The runtime (what the server actually loaded) is the ground truth.
    const meta = mustDetect(`{"id":"a","max_context_length":262144,"loaded_context_length":16384,
		"loaded_instances":[{"config":{"context_length":8192}}]}`);
    expect(meta?.contextWindow).toBe(8192);

    const topLevel = mustDetect(`{"id":"b","max_context_length":262144,"loaded_context_length":16384}`);
    expect(topLevel?.contextWindow).toBe(16384);

    // Capacity-only entries (no loaded-state field) are claimed by the LM
    // Studio detector itself.
    const capacity = mustDetect(`{"id":"c","max_context_length":262144}`);
    expect(capacity?.contextWindow).toBe(262144);
  });

  test("negative loaded_context_length falls through to the capacity branch", () => {
    // A negative loaded_context_length is an unset runtime window, not a
    // declaration: the capacity branch still claims the entry instead of
    // leaking it to the OpenAI-standard detector.
    const entry = `{"id":"e","loaded_context_length":-5,"max_context_length":262144}`;
    const direct = detectLmStudioMetadata(parse(entry));
    expect(direct?.contextWindow).toBe(262144);
    expect(mustDetect(entry)?.contextWindow).toBe(262144);

    // With no other window field the entry is still no match.
    expect(mustDetect(`{"id":"z","loaded_context_length":-5}`)).toBeUndefined();
  });

  test("the capacity branch is shielded by max_model_len", () => {
    // With the vLLM spelling max_model_len present, the advertised capacity
    // belongs to the OpenAI-standard detector's max_model_len-first
    // priority, so the LM Studio detector must decline the entry.
    const entry = `{"id":"s","max_model_len":131072,"max_context_length":999}`;
    expect(detectLmStudioMetadata(parse(entry))).toBeUndefined();
    // Through the chain the entry resolves via max_model_len instead.
    expect(mustDetect(entry)?.contextWindow).toBe(131072);

    // The shield guards the capacity branch only: a loaded runtime window
    // is still claimed even when max_model_len is present.
    const loaded = `{"id":"l","max_model_len":131072,"loaded_context_length":16384}`;
    expect(detectLmStudioMetadata(parse(loaded))?.contextWindow).toBe(16384);
  });

  test("no window fields does not match", () => {
    expect(detectLmStudioMetadata(parse(`{"id":"d","object":"model"}`))).toBeUndefined();
    expect(mustDetect(`{"id":"d","object":"model"}`)).toBeUndefined();
  });
});

describe("detectOpenAIStandardMetadata", () => {
  test("first non-zero of max_model_len / max_context_length / context_length wins", () => {
    // max_model_len (vLLM) beats max_context_length beats context_length
    // (Ollama); an entry reporting none is not a match.
    expect(mustDetect(`{"id":"a","max_model_len":131072,"max_context_length":999,"context_length":111}`)?.contextWindow).toBe(131072);
    expect(mustDetect(`{"id":"b","max_context_length":32768}`)?.contextWindow).toBe(32768);
    expect(mustDetect(`{"id":"c","context_length":8192}`)?.contextWindow).toBe(8192);
    expect(mustDetect(`{"id":"gpt-4o","object":"model"}`)).toBeUndefined();
  });

  test("negative fields decline instead of falling through", () => {
    // A negative max_model_len must not silently promote context_length,
    // and a negative capacity is no match at all.
    expect(mustDetect(`{"id":"h","max_model_len":-5,"context_length":8192}`)).toBeUndefined();
    expect(mustDetect(`{"id":"n","max_context_length":-5}`)).toBeUndefined();
    expect(detectOpenAIStandardMetadata(parse(`{"id":"h","max_model_len":-5,"context_length":8192}`))).toBeUndefined();
  });
});

describe("detectModelMetadata", () => {
  test("bare max_context_length is caught by the LM Studio detector first", () => {
    const meta = mustDetect(`{"id":"m","max_context_length":4096}`);
    expect(meta?.contextWindow).toBe(4096);
  });

  test("an aggregator entry is fully handled by the aggregator detector", () => {
    expect(mustDetect(aggregatorListingEntry)).toBeDefined();
  });

  test("unknown shapes decline to undefined", () => {
    for (const entry of [
      `{"id":"gpt-4o","object":"model"}`,
      `{"id":"m","limit":"not-an-object"}`,
    ]) {
      expect(mustDetect(entry)).toBeUndefined();
    }
    // An unparseable entry never reaches a detector (the caller's
    // JSON.parse throws first); a non-object input declines in the chain.
    expect(detectModelMetadata("not json at all")).toBeUndefined();
    expect(detectModelMetadata(null)).toBeUndefined();
    expect(detectModelMetadata([1, 2])).toBeUndefined();
  });

  test("an entry matching both shapes resolves through the aggregator detector", () => {
    // The chain order puts the aggregator detector ahead of the
    // OpenAI-standard detector, so the limit block wins over max_model_len.
    const meta = mustDetect(`{"id":"m","max_model_len":8192,"limit":{"context":200000,"output":32000}}`);
    expect(meta?.contextWindow).toBe(200000); // aggregator limit.context, not max_model_len 8192
    expect(meta?.outputLimit).toBe(32000); // only the aggregator detector declares one
  });
});

describe("aggregatorDeclaresAttachment", () => {
  test("image/PDF input modalities declare attachment", () => {
    for (const [input, want] of [
      [["text"], false],
      [["text", "image/png"], true],
      [["application/pdf"], true],
      [["image/webp", "text"], true],
      [[], false],
    ] as const) {
      expect(aggregatorDeclaresAttachment(input)).toBe(want);
    }
  });
});
