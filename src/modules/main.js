/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = ["NewWindow", "console",
                        "createButton", "destroyButton", "updateButton", "removeFromButtonSet", "ProfileAlias",
                        "ErrorHandler",
                        "Profile"
                       ];

var Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("${PATH_MODULE}/new-window.js");


#include "main.window.js"
#include "main.button.js"
#include "main.script-injection.js"
#include "main.network.js"
#include "main.cookies.js"
#include "main.storage.js"
#include "main.error.js"
#include "main.console.js"


const NewWindow = {
  newId: function(win) {
    var id;
    if (this._shouldBeDefault(win)) {
      id = Profile.DefaultIdentity;
    } else {
      id = Profile.lowerAvailableId(win);
    }
    console.log("newIdentity " + id);
    Profile.defineIdentity(win, id);
  },

  inheritId: function(newWin) {
    console.log("inheritId");
    var id;
    if (this._shouldBeDefault(newWin)) {
      id = Profile.DefaultIdentity;
    } else {
      //window.open()/fxstarting ==> opener=null
      var prevWin = newWin.opener;
      if (prevWin) {
        id = Profile.getIdentity(prevWin);
      } else {
        console.log("inheritId prevWin=" + prevWin);
        id = Profile.UndefinedIdentity;
      }
    }
    Profile.defineIdentity(newWin, id);
    console.log("/inheritId " + id);
  },

  applyRestore: function(win) {
    // restore: window is first configured by NewWindow.inheritId
    console.log("applyRestore");

    var stringId = Cc["@mozilla.org/browser/sessionstore;1"]
                    .getService(Ci.nsISessionStore)
                    .getWindowValue(win, "${BASE_DOM_ID}-identity-id");
    var id = Profile.toInt(stringId);
    if (id < Profile.DefaultIdentity) { //UndefinedIdentity?
      id = Profile.DefaultIdentity;
    }
    Profile.defineIdentity(win, id);
  },

  _shouldBeDefault: function(win) {
    // popup opened by an extension (like GTB)
    //var chromeHidden = win.document.documentElement.getAttribute("chromehidden");
    //return chromeHidden.indexOf("location") > -1;
    return false;
  }

};


const Profile = {
  UndefinedIdentity: 0,
  DefaultIdentity:   1,
  MaxIdentity:       999999999999999,

  defineIdentity: function(win, id) {
    console.assert(typeof id === "number", "id is not a number. " + typeof id);

    if (isPrivateWindow(win)) {
      id = Profile.UndefinedIdentity;
    }

    console.log("defineIdentity " + id);
    if (id > Profile.MaxIdentity) {
      console.log("id > max " + id);
      id = Profile.MaxIdentity;
    }
    if (id < Profile.UndefinedIdentity) {
      console.log("id < UndefinedIdentity " + id);
      id = Profile.UndefinedIdentity;
    }
    var current = Profile.getIdentity(win);
    if (current === id) {
      console.log("defineIdentity NOP");
      return id;
    }
    if (current !== Profile.DefaultIdentity) {
      BrowserWindow.unregister(win);
    }

    this._save(win, id);
    BrowserWindow.register(win);
    updateButton(win);

    return id;
  },

  getIdentity: function(chromeWin) {
    var tabbrowser = chromeWin.getBrowser();
    if (tabbrowser === null) {
      console.log("getIdentity=DefaultIdentity, tabbrowser=null");
      return Profile.DefaultIdentity;
    }

    if (tabbrowser.hasAttribute("${BASE_DOM_ID}-identity-id")) {
      return this.toInt(tabbrowser.getAttribute("${BASE_DOM_ID}-identity-id"));
    } else {
      return Profile.DefaultIdentity;
    }
  },

  _save: function(win, id) {
    console.log("save " + id);
    var node = win.getBrowser();
    if (id > Profile.DefaultIdentity) {
      node.setAttribute("${BASE_DOM_ID}-identity-id", id);
    } else {
      node.removeAttribute("${BASE_DOM_ID}-identity-id");
    }
    new SaveToSessionStore(win.document);
  },

  activeIdentities: function(ignoreWin) {
    var winEnum = Services.wm.getEnumerator("navigator:browser");
    var arr = [];
    while (winEnum.hasMoreElements()) {
      var win = winEnum.getNext();
      if (ignoreWin !== win) {
        var id = Profile.getIdentity(win);
        if (arr.indexOf(id) === -1) {
          arr.push(id);
        }
      }
    }
    return arr;
  },

  lowerAvailableId: function(ignoreWin) {
    var arr = this.activeIdentities(ignoreWin); //ignore win -- it doesn't have a session id yet
    var id = Profile.DefaultIdentity;
    while (arr.indexOf(id) > -1) {
      id++;
    }
    return id; // id is available
  },

  toInt: function(str) {
    var rv = parseInt(str, 10);
    return Number.isNaN(rv) ? Profile.DefaultIdentity : rv;
  },

  toString: function(id) {
    switch (id) {
      //case Profile.UndefinedIdentity:
      //  return "\u221e"; // ∞
      default:
        return id.toString();
    }
  }

};



function SaveToSessionStore(doc) {
  this._doc = Cu.getWeakReference(doc);
  this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  this._timer.init(this, 1300, Ci.nsITimer.TYPE_ONE_SHOT);
}

SaveToSessionStore.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]),

  observe: function(aSubject, aTopic, aData) {
    var doc = this._doc.get();
    if ((doc === null) || (doc.defaultView === null)) {
      return;
    }

    // BUG extension disabled => Components is not available
    // Profile.DefaultIdentity won't be saved

    var ss = Cc["@mozilla.org/browser/sessionstore;1"].getService(Ci.nsISessionStore);
    var val = Profile.getIdentity(doc.defaultView);

    try {
      // overwrite any previous value if called twice
      ss.setWindowValue(doc.defaultView, "${BASE_DOM_ID}-identity-id", val);
    } catch (ex) {
      // keep trying
      console.trace("SaveToSessionStore FAIL", val, doc, doc.defaultView, doc.defaultView.state, ex);
      this._timer.init(this, 700, Ci.nsITimer.TYPE_ONE_SHOT);
      return;
    }

    if (val <= Profile.DefaultIdentity) { // UndefinedIdentity OR DefaultIdentity
      ss.deleteWindowValue(doc.defaultView, "${BASE_DOM_ID}-identity-id");
    }
  }

};


const FindIdentity = {

  fromContent: function(contentWin) {
    if (contentWin === null) {
      return { profileNumber:  Profile.UndefinedIdentity,
               browserElement: null };
    }

    var profileId;
    var browser = ContentWindow.getContainerElement(contentWin);
    if (browser === null) {
      // source-view? -- BUG chat browser?
      profileId = this._getIdentityFromOpenerChrome(contentWin);
      return { profileNumber:  profileId,
               browserElement: null };
    }

    var chromeWin = browser.ownerDocument.defaultView;
    profileId = Profile.getIdentity(chromeWin);
    if (profileId !== Profile.UndefinedIdentity) {
      return { profileNumber:  profileId,
               browserElement: browser };
    }

    // popup via js/window.open
    profileId = this._getIdentityFromOpenerContent(contentWin, chromeWin);
    return { profileNumber:  profileId,
             browserElement: browser };
  },

  _getIdentityFromOpenerChrome: function(contentWin) {
    var chromeWin = ContentWindow.getTopLevelWindow(contentWin);
    if (chromeWin === null) {
      return Profile.UndefinedIdentity;
    }
    var tabbrowser = null;
    var type = chromeWin.document.documentElement.getAttribute("windowtype");
    if (type === "navigator:view-source") {
      var winOpener = chromeWin.opener;
      if (winOpener) {
        var type2 = winOpener.document.documentElement.getAttribute("windowtype");
        if (type2 === "navigator:browser") {
          tabbrowser = winOpener.getBrowser();
        }
      }
    }

    return tabbrowser !== null ? Profile.getIdentity(tabbrowser.ownerDocument.defaultView)
                               : Profile.UndefinedIdentity; // favicon, ...
  },

  _getIdentityFromOpenerContent: function(contentWin, chromeWin) {
    if (contentWin.opener) {
      var browserOpener = ContentWindow.getContainerElement(contentWin.opener);
      if (browserOpener) {
        var chromeOpener = browserOpener.ownerDocument.defaultView;
        var profileId = Profile.getIdentity(chromeOpener);
        if (profileId > Profile.UndefinedIdentity) {
          return Profile.defineIdentity(chromeWin, profileId);
        }
      }
    }

    return Profile.UndefinedIdentity;
  }
};


const ContentWindow = {
  getContainerElement: function(contentWin) {
    var chromeWin = this.getTopLevelWindow(contentWin);
    if ((chromeWin !== null) && ("getBrowser" in chromeWin)) {
      var elem = chromeWin.getBrowser();
      switch (elem.tagName) {
        case "tabbrowser":
          var topDoc = contentWin.top.document;
          var idx = elem.getBrowserIndexForDocument(topDoc);
          if (idx > -1) {
            return elem.browsers[idx];
          }
          break;
        default: // view-source => tagName="browser"
          console.log("getContainerElement=" + elem.tagName + " " +
                      contentWin.location + " " +chromeWin.location);
          break;
      }
    }
    return null;
  },


  getTopLevelWindow: function(win) { // content or chrome windows
    if ((!win) || (!win.QueryInterface)) {
      console.trace("getTopLevelWindow win=" + win);
      return null;
    }

    var topwin = win.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShellTreeItem)
                    .rootTreeItem
                    .QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIDOMWindow);

    console.assert(topwin !== null, "getTopLevelWindow null", win);
    console.assert(topwin !== undefined, "getTopLevelWindow undefined", win);
    console.assert(topwin === topwin.top, "getTopLevelWindow should return a top window");
    // unwrapped object allows access to gBrowser etc
    return XPCNativeWrapper.unwrap(topwin);
  }

};
