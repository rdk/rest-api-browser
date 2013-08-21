angular.module('RAB')
    .service('restResources', ['$rootScope', '$q',
        function ($rootScope, $q) {

            var alreadyLoaded = false;

            // var res = new Resources(scope)
            function ResourcesLoader(scope){
                // filter out crowd resources which require basic auth to use
                this.services = _.reject(RAB.rest.services, function(r){
                    return /usermanagement|appmanagement/.test(r.path)
                });
                this.resources = [];
                this.scope = scope;
            }

            // res.load().then(fn)
            ResourcesLoader.prototype.load = function(){
                var dfd = $q.defer();
                var self = this;
                var resolvedCount = 1;
                if (!alreadyLoaded) {
                    for(var i=0;i<self.services.length;i++){
                        var resource = self.services[i];
                        processWADL(resource).done(
                            function(r){
                                // emitter is available so that resources can be
                                // streamed in as they arrive
                                self.scope.$emit('resource-loaded', r);
                                self.resources = self.resources.concat(r.resources);
                                resolvedCount++;
                                if (resolvedCount === self.services.length) {
                                    dfd.resolve(self.resources);
                                    alreadyLoaded = true;
                                }
                            }
                        );
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