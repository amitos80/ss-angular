'use strict';
var module = angular.module('ssAngular',[]);

module.factory('pubsub', ['$rootScope', function($rootScope) {
    //override the $on function
    var old$on = $rootScope.$on;
    Object.getPrototypeOf($rootScope).$on = function(name, listener) {
        var scope = this;
        if(name.length > 3 && name.substr(0,3) === 'ss-') {
            ss.event.on(name, function(message) {
                scope.$apply(function(s) {
                    scope.$broadcast(name, message);
                });
            });
        }
        //make sure to call angular's version
        old$on.apply(this, arguments);
    };
}]);

module.factory('rpc', ['$q', '$rootScope', '$state', function($q, $rootScope, $state) {
    return function(command) {
        var args = Array.prototype.slice.apply(arguments);
        var deferred = $q.defer();
        ss.rpc.apply(ss, [command].concat(args.slice(1, args.length)).concat(
            function(response) {
                if(response && response.status != null){
                    if(response.status == 0){  // all good - continue
                        $rootScope.$apply(function(scope) {
                            deferred.resolve(response);
                        });
                    }else if(response.status == 2){ // user not authenticated
                        $state.transitionTo('login');
                    }else if(response.status == 3){ // registration not complete
                        if($rootScope.user){
                            if($rootScope.user.role == 'artist'){
                                $state.transitionTo('register.usertype.artist');
                            }else if($rootScope.user.role == 'label'){
                                $state.transitionTo('register.usertype.label');
                            }else if($rootScope.user.role == 'prmoter'){
                                $state.transitionTo('register.usertype.promoter');
                            }

                        }else{
                            $rootScope.$apply(function(scope) {
                                deferred.resolve(response);
                            });
                        }
                    }else if(response.status == 4) { // account not activated
                        $state.transitionTo('activate_account_message');
                    }else if(response.status == 5) { // account waiting for approval
                        $state.transitionTo('waiting_for_approval');
                    }
                }else{
                    $rootScope.$apply(function(scope) {
                        deferred.resolve(response);
                    });
                }
            }));
        return deferred.promise;
    };
}]);

module.factory('model', ['$rootScope','rpc', '$log', function($rootScope, rpc, $log) {

    Object.getPrototypeOf($rootScope).unlinkModel = function(scopeName) {
        var scope = this;

        if(!scope[scopeName] || !scope._models[scopeName]) {
            return;
        }
        ss.unlinkModel(scope._models[scopeName].name, scope._models[scopeName].params);
        delete scope[scopeName];
        delete scope._models[scopeName];
    };

    Object.getPrototypeOf($rootScope).linkModel = function(name, params, scopeName) {
        var scope = this;
        if(typeof params === "string") {
            scopeName = params;
            params = null;
        }
        if(!scopeName) {
            scopeName = name;
        }

        if(scope[scopeName]) {
            return;
        }

        if(!scope._models) {
            scope._models = {};
        }

        scope._models[scopeName] = {name:name,params:params};
        scope[scopeName] = {};

        ss.linkModel(name, params, function(modelObj) {
            scope.$apply(function(scope) {
                scope[scopeName] = modelObj;
            });
        });
        scope.$on('$destroy', function(s) {
            if(scope[scopeName]) {
                scope.unlinkModel(scopeName);
            }
        });
    };

    Object.getPrototypeOf($rootScope).modelSubscribe = function(name, params, scopeName) {
        var scope = this;
        if(typeof params === "string") {
            scopeName = params;
            params = null;
        }
        if(!scopeName) {
            scopeName = name;
        }

        if(scope[scopeName]) {
            $log.debug("modelSubscribe " + scopeName + " is already " + scope[scopeName]);
            return;
        }

        if(!scope._models) {
            scope._models = {};
        }

        scope._models[scopeName] = {name:name,params:params};

        $log.debug("modelSubscribe RPC: " + name + ".get");
        // Call to get initial value
        var promise = rpc(name + ".get", params);
        promise.then(function(result) {
            if (result.status == 0) {
                $log.debug(name + ".get",params, result.data);
                if (result.data) {
                    scope[scopeName] = result.data;
                }
            } else {
                scope[scopeName] = {};
                $log.debug("error ", result);
            }
        });


        // var paramString = JSON.stringify(params);
        // scope.$on('ss-' + name + "-" + paramString, function(event,msg) {
        //     scope[scopeName] = msg;
        // });

        // scope.$on('$destroy', function(s) {
        //   if(scope[scopeName]) {
        //     scope.unlinkModel(scopeName);
        //   }
        // });
    };
}]);

module.provider('auth', function() {
    var loginPath = '/login';
    var registerPath = '/register';
    var landingPagePath = '/';
    var authServiceModule = 'app';
    var unauthenticatedPath = new Array();

    this.loginPath = function(path) {
        loginPath = path;
        return this;
    };

    this.registerPath = function(path) {
        registerPath = path;
        return this;
    };

    this.unauthenticatedPath = function(path) {
        unauthenticatedPath.push(path);
        return this;
    };

    this.landingPagePath = function(path) {
        landingPagePath = path;
        return this;
    };

    this.authServiceModule = function(service) {
        authServiceModule = service;
        return this;
    };

    this.$get = ['$rootScope','$location', '$q', '$log', 'pubsub', 'analyticsutil', function($rootScope, $location, $q, $log, pubsub, analyticsutil) {

        var routeResponse = function() {
            $log.debug("1 $rootScope.entryPath :" + $rootScope.entryPath, ' $rootScope.user = ', $rootScope.user);

            var targetPath = $location.path();
            $log.debug("0 SSAngular Target path:" + targetPath);

            var components = targetPath.split("/");
            $log.debug("0 SSAngular: components[0]: " + components[0], ' components[1]: ', components[1], ' components[2]: ', components[2]);

            if(!$rootScope.origUrl){
                $rootScope.origUrl = $rootScope.entryPath;
            }

            var isModifiedUrl = false;
            // if a user is advertiser and trying to get in the publishers' system by changing url manually
            // we change back to advertisers
            if ($rootScope.user &&
                $rootScope.user.role != 'publisher' && $rootScope.user.role != "superuser"){

                if($rootScope.entryPath.indexOf('publishers') != -1){
                    $log.debug(" 10 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                    $rootScope.entryPath = $rootScope.entryPath.replace('publishers', 'advertisers');
                    isModifiedUrl = true;
                }

                if(targetPath.indexOf('publishers') != -1){
                    $log.debug(" 10 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                    targetPath = targetPath.replace('publishers', 'advertisers');
                    isModifiedUrl = true;
                }

                if(components[1] == 'publishers'){
                    $log.debug(" 10 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                    components[1] = 'advertisers';
                    isModifiedUrl = true;
                }
            }

            // if a user is publisher and trying to get in the advertisers' system by changing url manually
            // we change back to publisher
            if ($rootScope.user &&
                $rootScope.user.role == 'publisher'){

                if($rootScope.entryPath.indexOf('advertisers') != -1){
                    $rootScope.entryPath = $rootScope.entryPath.replace('advertisers', 'publishers');
                    isModifiedUrl = true;
                    $log.debug(" 11 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                }

                if(targetPath.indexOf('advertisers') != -1){
                    targetPath = targetPath.replace('advertisers', 'publishers');
                    isModifiedUrl = true;
                    $log.debug(" 11 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                }

                if(components[1] == 'advertisers'){
                    components[1] = 'publishers';
                    isModifiedUrl = true;
                    $log.debug(" 11 SSAngular: changed manually modified url to: ", ' $rootScope.entryPath = ', $rootScope.entryPath,  ' targetPath = ', targetPath, ' components[1] = ', components[1]);
                }
            }

            if(!$rootScope.authenticated) {

                $log.debug(" SSAngular 100 NOT AUTHENTICATED ");

            } else {
                $log.debug(" SSAngular 101 AUTHENTICATED $rootScope.entryPath = ", $rootScope.entryPath, " targetPath = ", targetPath, ' $rootScope.origUrl = ', $rootScope.origUrl);

                analyticsutil.people_set({
                    last_seen:new Date()
                });
            }

            if(isModifiedUrl){
                window.location = $rootScope.entryPath;
            }else{
                $location.path($rootScope.entryPath);
            }
        }


        // In any case where we haven't loaded the session yet, redirect to login
        if (!$rootScope.ready) {
            $log.debug("rootscope not ready");
            $rootScope.entryPath = $location.path();
            routeResponse();
        }

        if(!$rootScope.authenticated && !$rootScope.ready) {

            ss.server.on('ready', function() {
                $log.debug('Checking if authenticated');
                ss.rpc(authServiceModule + ".authenticated", $rootScope.sys,
                    function(response) {
                        $log.debug("response", response);

                        $rootScope.$apply(function(scope) {
                            if (response) {
                                $rootScope.user = response;
                                $rootScope.authenticated = true;
                            }
                            $log.debug('setting root scope as ready');
                            $rootScope.ready = true;
                            routeResponse();
                        });
                    });
            });
        }

        return {
            login: function(user, password, sys) {
                var deferred = $q.defer();
                ss.rpc(authServiceModule + ".authenticate", user, password, sys,
                    function(response) {
                        $rootScope.$apply(function(scope) {
                            if(response) {
                                scope.authenticated = true;
                                scope.user = response;
                                $log.debug("Authtincated: ", response)
                                deferred.resolve("Logged in");
                            }
                            else {
                                scope.authenticated = null;
                                deferred.reject("Invalid login");
                            }
                        });
                    });
                return deferred.promise;
            },

            logout: function() {
                var deferred = $q.defer();
                ss.rpc(authServiceModule + ".logout",
                    function() {
                        $rootScope.$apply(function(scope) {
                            scope.authenticated = null;
                            deferred.resolve("Success");
                        });
                    });
                return deferred.promise;
            }
        };
    }];
});
