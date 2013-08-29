'use strict';

angular.module('RAB')
    .service('restResources', ['$rootScope', '$q',
        function ($rootScope, $q) {

            var PUBLIC_APIS = [
                '^json-rpc/',
                '^api/',
                '^audit/',
                '^build\-status/',
                '^jira/1\.0/',
                '^ssh/',
                '^branch-permissions/',
                '^auth/',
                '^activity-stream/'
            ];
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
                        var isPublic = _.find(PUBLIC_APIS, function(txt){
                            var re = new RegExp(txt);
                            return re.test(resource.name);
                        });
                        if (isPublic){
                            resource.public = true;
                        } else {
                            resource.public = false;
                        }
                        return resource;
                    });
                    resolvedCount++;
                    if (resolvedCount === self.services.length) {
                        dfd.resolve(self.resources);
                        alreadyLoaded = true;
                    }
                };
                if (!alreadyLoaded) {

                    for(var i=0;i<self.services.length;i++){
                        var resource = self.services[i];
                        processWADL(resource).done(resolvedWADL);
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