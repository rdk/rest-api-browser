'use strict';

angular.module('RAB')
    .controller('ResourceCtrl', ['$scope', '$rootScope', '$routeParams', 'restResources',
        function ($scope,$rootScope,$routeParams,restResources) {
            // Custom method name sorting routine for tabs
            function methodNameValue(method){
                if (method.method === 'GET')     return 0;
                if (method.method === 'POST')    return 1;
                if (method.method === 'PUT')     return 2;
                if (method.method === 'PATCH')   return 3;
                if (method.method === 'HEAD')    return 4;
                if (method.method === 'OPTIONS') return 5;
                if (method.method === 'DELETE')  return 6;
            }

            // Listen for selected resource off of the $rootScope... pretty hacky.
            // The alternative is to call the resource loader again and search through
            // the resources array. This is probably more efficient since I'm
            // just passing the selected resource from the sidebarCtrl.
            if(!$rootScope.selectedResourceWatchSet) {
                $rootScope.$watch('selectedResource', function(newVal, oldVal){
                    $rootScope.selectedResourceWatchSet = true;
                    if(!newVal) return;
                    $rootScope.resource = newVal;
                    $rootScope.resource.methods = _.sortBy($rootScope.resource.methods,methodNameValue);
                    if($routeParams.method){
                        var method = _.where($rootScope.resource.methods, {method: $routeParams.method})[0];
                    } else {
                        var method = $rootScope.resource.methods[0];
                    }
                    try {
                        method.reqRep = method.representations.requests[0].mediaType;
                        method.reqBody = method.representations.requests[0].example;
                    } catch(e){}
                });
            } else {
                if($routeParams.method){
                    var method = _.where($rootScope.resource.methods, {method: $routeParams.method})[0];
                } else {
                    var method = $rootScope.resource.methods[0];
                }
                try {
                    method.reqRep = method.representations.requests[0].mediaType;
                    method.reqBody = method.representations.requests[0].example;
                } catch(e){}
            }

            $scope.addCustomParam = function(method){
                console.log(method)
                method.customParams = method.customParams ? method.customParams : [];
                method.customParams.push({});
            };

            $scope.removeCustomParam = function(idx, method){
                method.customParams.splice(idx,1);
            }

            $scope.isActive = function(idx){
                if($routeParams.method) {
                    return this.method.method === $routeParams.method;
                } else {
                    return idx === 0 ? true: false;
                }
            };

            $scope.selectUrl = function(evt){
                jQuery(evt.target).select().on('blur', function(){
                    $scope.$apply(function(){
                        $scope.mode = '';
                    });
                });
            };

            function serializeParams(params){

            }

            $scope.send = function(method){
                var url;
                _.each(_.where(method.params,{style:"template"}), function(tmplVar) {
                    var pat = new RegExp('\{' + tmplVar.name + '\:?(.*)\}', 'g');
                    url = $rootScope.resource.url.replace(pat, tmplVar.value);
                });
                var params = _.chain(method.params)
                    .filter(function(o){
                        return o.style !== "template";
                    })
                    .map(function(o){
                        if(o.value) {
                            return encodeURIComponent(o.name)+"="+encodeURIComponent(o.value);
                        }
                    })
                    .compact()
                    .join('&')
                    .value();
                var outputType = "json";
                if (method.reqRep === 'application/xml') {
                    outputType = 'xml';
                } else if (method.reqRep === 'text/plain') {
                    outputType = 'text';
                } else {
                    outputType = 'json';
                }

//                jQuery.ajax({
//                    url: url,
//                    type: method.method,
//                    data: data,
//                    contentType: method.reqRep,
//                    dataType: outputType,
//                    beforeSend: function(){
//
//                    },
//                    complete: function(){
//
//                    }
//                });
            }
        }]
    );
