"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const jsonl_parser_js_1 = require("../src/daemon/streams/jsonl-parser.js");
(0, node_test_1.describe)('JSONL Parser', () => {
    (0, node_test_1.it)('should parse single complete line', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed('{"type":"text","content":"hello"}\n');
        parser.flush();
        strict_1.default.equal(lines.length, 1);
        strict_1.default.equal(lines[0], '{"type":"text","content":"hello"}');
    });
    (0, node_test_1.it)('should handle chunked input split across lines', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed('{"type":"a"}\n{"ty');
        parser.feed('pe":"b"}\n');
        parser.flush();
        strict_1.default.equal(lines.length, 2);
        strict_1.default.equal(lines[0], '{"type":"a"}');
        strict_1.default.equal(lines[1], '{"type":"b"}');
    });
    (0, node_test_1.it)('should flush remaining buffer without trailing newline', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed('{"type":"a"}\n{"type":"b"}');
        strict_1.default.equal(lines.length, 1); // only first line emitted
        parser.flush();
        strict_1.default.equal(lines.length, 2); // second line emitted on flush
        strict_1.default.equal(lines[1], '{"type":"b"}');
    });
    (0, node_test_1.it)('should skip empty lines', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed('{"type":"a"}\n\n\n{"type":"b"}\n');
        parser.flush();
        strict_1.default.equal(lines.length, 2);
    });
    (0, node_test_1.it)('should handle \\r\\n line endings', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed('{"type":"a"}\r\n{"type":"b"}\r\n');
        parser.flush();
        strict_1.default.equal(lines.length, 2);
        strict_1.default.equal(lines[0], '{"type":"a"}');
        strict_1.default.equal(lines[1], '{"type":"b"}');
    });
    (0, node_test_1.it)('should handle Buffer input', () => {
        const lines = [];
        const parser = (0, jsonl_parser_js_1.createJsonlParser)((line) => lines.push(line));
        parser.feed(Buffer.from('{"type":"a"}\n{"type":"b"}\n'));
        parser.flush();
        strict_1.default.equal(lines.length, 2);
    });
});
//# sourceMappingURL=jsonl-parser.test.js.map