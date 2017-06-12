'use strict';
const net = require('net');
const { launch } = require('lighthouse/chrome-launcher');
const chrome = require('chrome-remote-interface');

/**
 * get next free port in system
 * @returns {Promise}
 */
function sysFreePort() {
    return new Promise((resolve, reject) => {
        let server = net.createServer();
        server.listen(0, function () {
            const port = server.address().port;
            server.once('close', function () {
                resolve(port);
            });
            server.close();
            server = null;
        });
        server.on('error', function (err) {
            reject(err);
        });
    });
}

/**
 * launch Chrome
 * @returns {Promise.<function>} chrome launcher
 */
async function launchChrome(port) {
    return await launch({
        port: port,
        chromeFlags: [
            '--headless',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-speech-api',
            '--disable-signin-scoped-device-id',
            '--disable-component-extensions-with-background-pages',
        ]
    });
}

/**
 * ChromeTabsPool used to manage chrome tabs, for reuse tab
 * use #new() static method to make a ChromeTabsPool, don't use new ChromeTabsPool()
 * #new() is a async function, new ChromeTabsPool is use able util await it to be completed
 */
class ChromeTabsPool {

  /**
   * make a new ChromeTabsPool
   * @param {number} maxTab max tab to render pages, default is no limit
   * @returns {Promise.<*>}
   */
  static async new(maxTab = Infinity) {
    const port = await sysFreePort();
    const chromeTabsPoll = new ChromeTabsPool();
    chromeTabsPoll.port = port;
    chromeTabsPoll.chromeLauncher = await launchChrome(port);
    chromeTabsPoll.tabs = {};
    chromeTabsPoll.maxTab = maxTab;
    chromeTabsPoll.requireResolveTasks = [];

    // Request the list of the available open targets/tabs of the remote instance.
    // @see https://github.com/cyrus-and/chrome-remote-interface/#cdplistoptions-callback
    const tabs = await chrome.List({ port });

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const { id, type } = tab;
      // ignore background_page
      if (type === 'page') {
        chromeTabsPoll.tabs[id] = {
          free: true,
          client: await chromeTabsPoll.connectTab(id),
        };
      }
    }
    return chromeTabsPoll;
  }

  /**
   * connect to an exited tab then add it to poll
   * @param {string} tabId chrome tab id
   * @return {Promise.<{tabId: *, Page: *, DOM: *, Runtime: *, Network: *}>}
   */
  async connectTab(tabId) {

    // Connects to a remote instance using the Chrome Debugging Protocol.
    // @see https://github.com/cyrus-and/chrome-remote-interface/#cdpoptions-callback
    const protocol = await chrome({
      target: tabId,
      port: this.port,
    });

    const { Page, DOM, Runtime, Network } = protocol;
    await Promise.all([Page.enable(), DOM.enable(), Runtime.enable(), Network.enable()]);
    return {
      tabId,
      Page,
      DOM,
      Runtime,
      Network,
    }
  }

  /**
   * create a new tab in connected chrome then add it to poll
   * if tab count >= maxTab will not create new tab and return undefined
   * @return {Promise.<string>} tabId
   */
  async createTab() {
    const tabCount = Object.keys(this.tabs).length;
    if (tabCount < this.maxTab) {

      // Create a new target/tab in the remote instance.
      // @see https://github.com/cyrus-and/chrome-remote-interface/#cdpnewoptions-callback
      const tab = await chrome.New({ port: this.port });

      const { id } = tab;
      this.tabs[id] = {
        free: true,
        client: await this.connectTab(id),
      };
      return id;
    }
  }

  /**
   * get now is free tab to do job then set this tab to be busy util call #release() on this tab
   * @return {Promise.<{tabId: *, Page: *, DOM: *, Runtime: *, Network: *}|*>}
   */
  async require() {
    let tabId = Object.keys(this.tabs).find(id => this.tabs[id].free);
    if (tabId === undefined) {
      tabId = await this.createTab();
      // up to maxTab limit, should wait for tab release
      if (tabId === undefined) {
        tabId = await new Promise((resolve) => {
          this.requireResolveTasks.unshift(resolve);
        });
      }
    }
    const tab = this.tabs[tabId];
    tab.free = false;
    return tab.client;
  }

  /**
   * call on a tab when your job on this tab is finished
   * @param {string} tabId
   */
  async release(tabId) {
    let tab = this.tabs[tabId];
    // navigate this tab to blank to release this tab's resource
    await tab.client.Page.navigate({ url: 'about:blank' });
    tab.free = true;
    if (this.requireResolveTasks.length > 0) {
      const resolve = this.requireResolveTasks.pop();
      resolve(tabId);
    }
  }

  /**
   * close chrome and release all resource used by this poll
   * @return {Promise.<void>}
   */
  async destroyPoll() {
    await this.chromeLauncher.kill();
    this.tabs = null;
    this.chromeLauncher = null;
    this.port = null;
    this.requireResolveTasks = null;
  }

}

module.exports = ChromeTabsPool;