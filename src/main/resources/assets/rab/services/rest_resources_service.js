'use strict';

angular.module('RAB')
    .service('restResources', ['$rootScope', '$q',
        function ($rootScope, $q) {

            var JIRA_PUBLIC_APIS = [
                '^json-rpc/',
                '^api/2',
                '^auth/',
                '^activities/'
            ];

            var CONFLUENCE_PUBLIC_APIS = [
                '^api/'
            ];

            var STASH_PUBLIC_APIS = [
                '^api/',
                '^audit/',
                '^build\-status/',
                '^jira/1\.0/',
                '^ssh/',
                '^branch-permissions/',
                '^auth/'
            ];

            var BAMBOO_PUBLIC_APIS = [
                '^api/'
            ]

            var PUBLIC_APIS = [];
            if(/JIRA/i.test(RAB.product)) { PUBLIC_APIS = JIRA_PUBLIC_APIS }
            else if(/Confluence/i.test(RAB.product)) { PUBLIC_APIS = CONFLUENCE_PUBLIC_APIS }
            else if(/Stash/i.test(RAB.product)) { PUBLIC_APIS = STASH_PUBLIC_APIS }
            else if(/Bamboo/i.test(RAB.product)) { PUBLIC_APIS = BAMBOO_PUBLIC_APIS }

            var compiledPublicAPIRe = new RegExp("("+PUBLIC_APIS.join("|")+")");
            var alreadyLoaded = false;

            // var res = new Resources(scope)
            function ResourcesLoader(scope){
                // filter out crowd resources which require basic auth to use
                this.services = _.reject(RAB.rest.services, function(r){
                    return (/usermanagement|appmanagement/.test(r.wadl));
                });
                this.resources = [];
                this.scope = scope;
            }

            // res.load().then(fn)
            ResourcesLoader.prototype.load = function(){
                var dfd = $q.defer();
                var self = this;
                var resolvedCount = 1;
                var resolvedWADL = function(r){
                    // emitter is available so that resources can be
                    // streamed in as they arrive
                    self.scope.$emit('resource-loaded', r);
                    self.resources = self.resources.concat(r.resources);
                    self.resources = _.map(self.resources, function(resource){
                        if (PUBLIC_APIS.length > 0 && compiledPublicAPIRe.test(resource.name)){
                            resource.public = true;
                        } else {
                            resource.public = false;
                        }
                        return resource;
                    });
                };

                // Handle the good and bad (bad are effectively skipped)
                var handledWADL = function() {
                    resolvedCount++;
                    if (resolvedCount === self.services.length) {
                        dfd.resolve(self.resources);
                        alreadyLoaded = true;
                    }
                };

                if (!alreadyLoaded) {

                    for(var i=0;i<self.services.length;i++){
                        var resource = self.services[i];
                        processWADL(resource).done(resolvedWADL).always(handledWADL);
                    }
                } else {
                    dfd.resolve(resources);
                }
                return dfd.promise;
            };

            // public api
            return {
                ResourcesLoader: ResourcesLoader
            };
        }
    ]);