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

            function SendRequestError(msg){
                AJS.messages.error("#rab-errors",{
                    title: "Send request error",
                    body: msg
                });
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
                method.customParams = method.customParams ? method.customParams : [];
                method.customParams.push({});
            };

            $scope.removeCustomParam = function(idx, method){
                method.customParams.splice(idx,1);
            }

            $scope.isJsonRPC = function(){
                if(/^json\-rpc/i.test($rootScope.resource.name)) {
                    return true;
                }
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

            $scope.clearResults = function(){
                this.method.response = null;
            }

            $scope.send = function(method){
                jQuery('#rab-errors').html("");
                var url, queryParams, jsonRpcParams, customParams, contentType, outputType, data;

                url = $rootScope.resource.url;
                _.each(_.where(method.params,{style:"template"}), function(tmplVar) {
                    var pat = new RegExp('\{' + tmplVar.name + '\:?(.*)\}', 'g');
                    if(!tmplVar.value) {
                        throw new SendRequestError("You forgot to provide a value for the following required parameter: <b>" + tmplVar.name + "</b>");
                    }
                    url = url.replace(pat, tmplVar.value);
                });

                queryParams = _.chain(_.compact(method.params.concat(method.customParams)))
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

                if (queryParams.length > 0) {
                    url += "?" + queryParams;
                }

                if ((method.method === "POST" || method.method === "PUT" || method.method === "PATCH") && method.reqBody) {
                    data = method.reqBody ? method.reqBody.trim() : {};
                }

                if (!method.reqRep) {
                    contentType = 'application/json';
                } else {
                    contentType = method.reqRep;
                }

                if (method.reqRep === 'application/xml') {
                    outputType = 'xml';
                } else if (method.reqRep === 'text/plain') {
                    outputType = 'text';
                } else {
                    outputType = 'json';
                }

                jQuery.ajax({
                    url: url,
                    type: method.method,
                    data: data,
                    contentType: contentType,
                    dataType: outputType,
                    beforeSend: function(){

                    },
                    complete: function(){
                    }
                }).done(function(d, msg, o){
                    $scope.$apply(function(){
                        var contentType;
                        method.response = {};
                        method.response.headers = o.getAllResponseHeaders();
                        contentType = o.getResponseHeader('Content-Type');
                        if (/^application\/xml/.test(contentType)) {
                            method.response.body = o.responseText;
                        } else {
                            try {
                                method.response.body = JSON.stringify(d, null, 2);
                            } catch(e) {
                                try {
                                    method.response.body = d.documentElement.innerHTML;
                                } catch(e) {
                                    method.response.body = d;
                                }
                            }
                        }
                        if (method.response.body == null) method.response.body = "";
                        method.response.status = "success";
                        method.response.call = url + " (" + o.status + ")";
                    });
                }).fail(function(o, msg, descr) {
                    $scope.$apply(function(){
                        method.response = {};
                        method.response.headers = o.getAllResponseHeaders();
                        try {
                            method.response.body = JSON.stringify(JSON.parse(o.responseText), null, 2);
                        } catch(e) {
                            method.response.body = o.responseText;
                        }
                        if (method.response.body == null) method.response.body = "";
                        method.response.status = "error";
                        method.response.call = url + " (" + o.status + ")";
                    });
               });
            }
        }]
    );
