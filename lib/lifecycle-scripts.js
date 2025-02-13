"use strict";

/* eslint-disable no-magic-numbers, max-statements, no-eval */

//
// execute npm scripts
//

const Path = require("path");
const optionalRequire = require("optional-require")(eval("require"));
const assert = require("assert");
const xsh = require("xsh");
const Promise = require("bluebird");
const chalk = require("chalk");
const _ = require("lodash");
const logger = require("./logger");
const logFormat = require("./util/log-format");
const VisualExec = require("visual-exec");
const fyntil = require("./util/fyntil");
const requireAt = require("require-at");

const npmConfigEnv = require("./util/npm-config-env");

const readPkgJson = dir => {
  return fyntil.readPkgJson(dir).catch(() => {
    return {};
  });
};

xsh.Promise = Promise;

// When released, all code are bundled into dist/fyn.js
// When running from original source, this is under lib/lifecycle-scripts.js
// It's important to maintain same level so "../package.json" works.
const fynInstalledDir = Path.dirname(optionalRequire.resolve("../package.json"));

/*
 * ref: https://github.com/npm/npm/blob/75b462c19ea16ef0d7f943f94ff4d255695a5c0d/lib/utils/lifecycle.js
 * docs: https://docs.npmjs.com/misc/scripts
 *
 */

const ONE_MB = 1024 * 1024;

const getGlobalNodeModules = () => {
  const nodeDir = Path.dirname(process.execPath);
  if (process.platform === "win32") {
    // windows put node binary under <installed_dir>/node.exe
    // and node_modules under <installed_dir>/node_modules
    return Path.join(nodeDir, "node_modules");
  } else {
    // node install on unix put node binary under <installed_dir>/bin/node
    // and node_modules under <installed_dir>/lib/node_modules
    return Path.join(Path.dirname(nodeDir), "lib/node_modules");
  }
};

class LifecycleScripts {
  constructor(options) {
    if (typeof options === "string") {
      options = { dir: options };
    }
    this._fyn = options._fyn || {};
    this._pkgDir = options.dir;
    this._options = Object.assign({}, options);
  }

  makeEnv(override) {
    // let env = Object.assign({}, process.env, override);
    // this._addNpmPackageConfig(this._appPkg.config, env);
    // this._addNpmPackageConfig(this._pkg.config, env);

    const env = Object.assign({}, npmConfigEnv(this._pkg, this._fyn.allrc || {}), override);
    const npmDir = Path.join(getGlobalNodeModules(), "npm");

    try {
      const ra = requireAt(npmDir);
      const npmLifecycleDir = Path.dirname(ra.resolve("npm-lifecycle/package.json"));
      xsh.envPath.addToFront(Path.join(npmLifecycleDir, "node-gyp-bin"), env);
      env.npm_config_node_gyp = ra.resolve("node-gyp/bin/node-gyp");
    } catch (err) {
      logger.debug("failed to resolve node-gyp dir from npm, using defaults.", err);
      xsh.envPath.addToFront(Path.join(npmDir, "node_modules/npm-lifecycle/node-gyp-bin"), env);
      env.npm_config_node_gyp = Path.join(npmDir, "node_modules/node-gyp/bin/node-gyp.js");
    }

    if (this._appDir) {
      xsh.envPath.addToFront(Path.join(this._appDir, "node_modules/.bin"), env);
    }
    xsh.envPath.addToFront(Path.join(this._pkgDir, "node_modules/.bin"), env);

    // env.npm_lifecycle_event = stage;  // TODO

    env.npm_node_execpath = env.NODE = env.NODE || process.execPath;
    env.npm_execpath = fynInstalledDir;
    env.INIT_CWD = this._fyn.cwd;

    return env;
  }

  execute(aliases, silent) {
    return Promise.try(() => this._execute(aliases, silent));
  }

  async _initialize() {
    const options = this._options;
    if (options.appDir && options.appDir !== options.dir) {
      this._appDir = options.appDir;
      this._appPkg = await readPkgJson(this._appDir);
    } else {
      this._appPkg = {};
    }

    this._pkg = options.json || (await readPkgJson(this._pkgDir));
    assert(this._pkg, `Unable to load package.json from ${this._pkgDir}`);
    if (!this._pkg.scripts) {
      this._pkg.scripts = {};
    }
  }

  async _execute(aliases, silent) {
    if (!this._pkg) {
      await this._initialize();
    }

    if (typeof aliases === "string") aliases = [aliases];

    const name = _.keys(this._pkg.scripts).find(x => aliases.indexOf(x) >= 0);

    if (!name || !this._pkg.scripts.hasOwnProperty(name)) {
      return false;
    }

    assert(
      this._pkg.scripts[name],
      `No npm script ${name} found in package.json in ${this._pkgDir}.`
    );

    const pkgName = logFormat.pkgId(this._pkg);
    const dimPkgName = chalk.dim(pkgName);
    const scriptName = chalk.magenta(name);
    const script = `"${chalk.cyan(this._pkg.scripts[name])}"`;
    const pkgDir = logFormat.pkgPath(this._pkg.name, this._pkgDir);

    logger.verbose(`executing ${dimPkgName} npm script ${scriptName} ${script} ${pkgDir}`);

    const child = xsh.exec(
      {
        silent,
        cwd: this._pkgDir,
        env: this.makeEnv({ PWD: this._pkgDir }),
        maxBuffer: ONE_MB
      },
      this._pkg.scripts[name]
    );

    if (!silent) return child.promise;

    const ve = new VisualExec({
      command: this._pkg.scripts[name],
      cwd: this._pkgDir,
      visualLogger: logger,
      displayTitle: `Running ${scriptName} of ${pkgName}`,
      logLabel: `${pkgName} npm script ${scriptName}`,
      outputLabel: `${dimPkgName} npm script ${scriptName}`
    });

    return ve.show(child);
  }
}

module.exports = LifecycleScripts;
