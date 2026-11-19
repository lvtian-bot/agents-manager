function normalizeNewlines(text) {
    return String(text).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

// ===== 正文结构解析（两级共用） =====

function extractInstructionBody(noteContent) {
    var normalized = normalizeNewlines(noteContent);
    var match = normalized.match(/^---\n[\s\S]*?\n---\n?/);
    if (!match) {
        if (normalized.startsWith("---\n")) throw new Error("源笔记的 YAML 属性未闭合。");
        return normalized.trimEnd() + "\n";
    }
    var body = normalized.slice(match[0].length).replace(/^\n+|\n+$/g, "");
    return body + "\n";
}

function isLevel1Heading(line) {
    // 仅识别「# 」开头的一级标题：## 子标题、#标签、不带空格的 #井号 都不算。
    // 标题文本不参与判定，模板和项目可自由修改标题措辞。
    return /^# /.test(line);
}

function splitFrontmatter(text) {
    var match = text.match(/^---\n[\s\S]*?\n---\n?/);
    if (!match) {
        return { frontmatter: "", body: text };
    }
    return { frontmatter: match[0], body: text.slice(match[0].length) };
}

function parseWorkStructure(text) {
    var normalized = normalizeNewlines(text);
    var parts = splitFrontmatter(normalized);
    // 一级标题只在 frontmatter 之外识别，避免 YAML 注释干扰。
    var lines = parts.body.split("\n");

    var headingIndices = [];
    lines.forEach(function (line, index) {
        if (isLevel1Heading(line)) {
            headingIndices.push(index);
        }
    });

    if (headingIndices.length < 2) {
        throw new Error(
            "正文一级标题（「# 」开头）不足两个：第 1 个到第 2 个一级标题之间是同步区块，" +
                "第 2 个一级标题及其后内容属于项目，永远不会改动。"
        );
    }

    return {
        frontmatter: parts.frontmatter,
        // before 含与第 1 个一级标题行之间的分隔换行，保证重建时字节保真。
        before: headingIndices[0] > 0 ? lines.slice(0, headingIndices[0]).join("\n") + "\n" : "",
        // 区块含第 1 个一级标题行，至第 2 个一级标题行之前。
        workSection: lines.slice(headingIndices[0], headingIndices[1]).join("\n"),
        after: lines.slice(headingIndices[1]).join("\n")
    };
}

function rebuildDocument(structure, newWorkSection) {
    return structure.frontmatter + structure.before + newWorkSection + "\n" + structure.after;
}

function computeLineDiff(aLines, bLines) {
    // 经典 LCS：a=源侧，b=外部侧。产出操作序列 equal/del/ins。
    var n = aLines.length;
    var m = bLines.length;
    var dp = [];
    for (var i = 0; i <= n; i++) {
        dp.push(new Array(m + 1).fill(0));
    }
    for (var i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
            dp[i][j] = aLines[i] === bLines[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    var ops = [];
    var i = 0;
    var j = 0;
    while (i < n && j < m) {
        if (aLines[i] === bLines[j]) {
            ops.push({ type: "equal", text: aLines[i], aLine: i + 1, bLine: j + 1 });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ type: "del", text: aLines[i], aLine: i + 1 });
            i++;
        } else {
            ops.push({ type: "ins", text: bLines[j], bLine: j + 1 });
            j++;
        }
    }
    while (i < n) {
        ops.push({ type: "del", text: aLines[i], aLine: i + 1 });
        i++;
    }
    while (j < m) {
        ops.push({ type: "ins", text: bLines[j], bLine: j + 1 });
        j++;
    }
    return ops;
}

function composeMergedBody(ops, keepFlags) {
    // keepFlags 与 ops 等长；equal 恒保留，del/ins 按勾选。
    var out = [];
    for (var k = 0; k < ops.length; k++) {
        var op = ops[k];
        if (op.type === "equal" || keepFlags[k]) {
            out.push(op.text);
        }
    }
    return out.join("\n");
}

// config 由 buildChannelMergeConfig 构造；弹窗本身不关心通道差异。

module.exports = { normalizeNewlines, extractInstructionBody, splitFrontmatter, parseWorkStructure, rebuildDocument, computeLineDiff, composeMergedBody };
