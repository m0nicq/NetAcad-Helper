/*
 * Answer matching helpers shared by content.js (page context) and unit tests.
 * Pure functions only — no DOM access.
 */
(function attach(global) {
    "use strict";

    const DEFAULT_THRESHOLD = 0.82;

    function normalizeText(input) {
        return String(input == null ? "" : input)
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .replace(/\s+\d+\s+of\s+\d+\s*$/i, "") // screen-reader "1 of 5" leftovers
            .replace(/[.,;:!?]+$/u, "")
            .trim()
            .toLowerCase();
    }

    // 0..1 similarity between two strings.
    function similarityScore(a, b) {
        const x = normalizeText(a);
        const y = normalizeText(b);
        if (!x || !y) return 0;
        if (x === y) return 1;

        // One contains the other (handles wrapped/fragmented answers).
        const shorter = x.length <= y.length ? x : y;
        const longer = x.length > y.length ? x : y;
        if (longer.includes(shorter)) {
            return 0.9 + 0.1 * (shorter.length / longer.length);
        }

        // Dice coefficient over tokens (tolerates small wording differences).
        const tx = x.split(" ");
        const ty = y.split(" ");
        const counts = new Map();
        for (const token of tx) counts.set(token, (counts.get(token) || 0) + 1);

        let overlap = 0;
        for (const token of ty) {
            const count = counts.get(token) || 0;
            if (count > 0) {
                overlap++;
                counts.set(token, count - 1);
            }
        }

        return (2 * overlap) / (tx.length + ty.length);
    }

    // Splits an AI answer into individual option lines.
    // The prompt asks for a blank line between options, but models often use
    // single newlines — fall back to line-splitting when that happens.
    function parseAnswerLines(answerText) {
        const raw = String(answerText == null ? "" : answerText)
            .replace(/\r/g, "")
            .trim();
        if (!raw) return [];

        const byBlankLine = raw.split(/\n\s*\n/).map(stripLineNoise).filter(Boolean);
        const parts = byBlankLine.length > 1 ? byBlankLine : raw.split(/\n/).map(stripLineNoise).filter(Boolean);

        const unique = [];
        const seen = new Set();
        for (const part of parts) {
            if (!seen.has(part)) {
                seen.add(part);
                unique.push(part);
            }
        }
        return unique;
    }

    function stripLineNoise(line) {
        return normalizeText(String(line).replace(/^\s*(?:[-*•]|\d+[.)]|[a-f][.)])\s+/i, ""));
    }

    /*
     * Maps answer lines onto page options.
     *
     * questions: [{ single: boolean, options: [{ text }] }]
     *   - single: question accepts only one option (radio). Multi-select questions
     *     (checkbox / "Choose two") may match several lines.
     *
     * Returns:
     *   {
     *     assignments: [{ questionIndex, optionIndex, score, line, text }],
     *     notMatched: [lines that found no option]
     *   }
     */
    function matchAnswersToOptions(answerLines, questions, threshold) {
        const limit = typeof threshold === "number" ? threshold : DEFAULT_THRESHOLD;
        const lines = Array.isArray(answerLines) ? answerLines : [];
        const candidates = [];

        (questions || []).forEach((question, questionIndex) => {
            const scored = (question.options || []).map((option, optionIndex) => {
                let best = 0;
                let bestLine = -1;
                lines.forEach((line, lineIndex) => {
                    const score = similarityScore(line, option.text);
                    if (score > best) {
                        best = score;
                        bestLine = lineIndex;
                    }
                });
                return { questionIndex, optionIndex, score: best, lineIndex: bestLine, text: option.text };
            }).filter((candidate) => candidate.lineIndex >= 0 && candidate.score >= limit);

            if (question.single && scored.length > 1) {
                scored.sort((a, b) => b.score - a.score);
                scored.splice(1); // radio question: only the best match
            }

            candidates.push(...scored);
        });

        // Best score first; a line can only be consumed once, globally.
        candidates.sort((a, b) => b.score - a.score);

        const usedLines = new Set();
        const usedOptions = new Set();
        const assignments = [];

        for (const candidate of candidates) {
            const optionKey = candidate.questionIndex + ":" + candidate.optionIndex;
            if (usedLines.has(candidate.lineIndex) || usedOptions.has(optionKey)) continue;

            usedLines.add(candidate.lineIndex);
            usedOptions.add(optionKey);
            assignments.push({
                questionIndex: candidate.questionIndex,
                optionIndex: candidate.optionIndex,
                score: candidate.score,
                line: lines[candidate.lineIndex],
                text: candidate.text
            });
        }

        const notMatched = lines.filter((line, index) => !usedLines.has(index));
        return { assignments, notMatched };
    }

    global.AnswerMatcher = {
        DEFAULT_THRESHOLD,
        normalizeText,
        similarityScore,
        parseAnswerLines,
        matchAnswersToOptions
    };
})(typeof self !== "undefined" ? self : this);
