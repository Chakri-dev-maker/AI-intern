sap.ui.require(
    [
        'sap/fe/test/JourneyRunner',
        'com/qil/rag/settings/settings/test/integration/FirstJourney',
		'com/qil/rag/settings/settings/test/integration/pages/SettingsMain'
    ],
    function(JourneyRunner, opaJourney, SettingsMain) {
        'use strict';
        var JourneyRunner = new JourneyRunner({
            // start index.html in web folder
            launchUrl: sap.ui.require.toUrl('com/qil/rag/settings/settings') + '/index.html'
        });

       
        JourneyRunner.run(
            {
                pages: { 
					onTheSettingsMain: SettingsMain
                }
            },
            opaJourney.run
        );
    }
);