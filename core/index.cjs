/** core 聚合出口（测试 / 服务端共用）。 */
const util = require("./util.cjs");
const frontmatter = require("./frontmatter.cjs");
const zip = require("./zip.cjs");
const source = require("./source.cjs");
const inspect = require("./inspect.cjs");
const conflicts = require("./conflicts.cjs");
const install = require("./install.cjs");

module.exports = { ...util, ...frontmatter, ...zip, ...source, ...inspect, ...conflicts, ...install };
