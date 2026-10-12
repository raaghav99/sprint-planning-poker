/**
 * Standalone Sprint Planning Poker - Engine & Statistics Helper
 */

export class PokerEngine {
    /**
     * Compute statistics from votes object { peerId: estimateStr }
     * @param {Object} votes
     * @returns {Object} stats summary
     */
    static calculateStats(votes) {
        const voteEntries = Object.entries(votes || {});
        const totalVotes = voteEntries.length;

        if (totalVotes === 0) {
            return {
                totalVotes: 0,
                numericVotesCount: 0,
                average: 0,
                median: 0,
                min: 0,
                max: 0,
                isConsensus: false,
                consensusValue: null,
                distribution: {}
            };
        }

        const distribution = {};
        const numericValues = [];

        voteEntries.forEach(([_, val]) => {
            if (!val) return;
            const cleanVal = String(val);
            distribution[cleanVal] = (distribution[cleanVal] || 0) + 1;

            const num = parseFloat(cleanVal);
            if (!isNaN(num)) {
                numericValues.push(num);
            }
        });

        const numericCount = numericValues.length;
        let average = 0;
        let median = 0;
        let min = 0;
        let max = 0;

        if (numericCount > 0) {
            numericValues.sort((a, b) => a - b);

            const sum = numericValues.reduce((acc, curr) => acc + curr, 0);
            average = Math.round((sum / numericCount) * 10) / 10;

            min = numericValues[0];
            max = numericValues[numericCount - 1];

            const mid = Math.floor(numericCount / 2);
            if (numericCount % 2 === 0) {
                median = Math.round(((numericValues[mid - 1] + numericValues[mid]) / 2) * 10) / 10;
            } else {
                median = numericValues[mid];
            }
        }

        const uniqueVoteValues = Object.keys(distribution);
        const isConsensus = uniqueVoteValues.length === 1 && totalVotes > 1;
        const consensusValue = isConsensus ? uniqueVoteValues[0] : null;

        return {
            totalVotes,
            numericVotesCount: numericCount,
            average,
            median,
            min,
            max,
            isConsensus,
            consensusValue,
            distribution
        };
    }

    /**
     * Export sprint session history to CSV
     * @param {Array} history
     */
    static exportToCSV(history) {
        if (!history || history.length === 0) return;

        const headers = ['Story Title', 'Agreed Score', 'Average', 'Total Votes', 'Timestamp'];
        // Quote every cell, double embedded quotes, and neutralise spreadsheet formulas (= + - @).
        const cell = (value) => {
            let text = String(value ?? '');
            if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
        };

        const rows = history.map(item => [
            cell(item.title),
            cell(item.agreedPoints ?? 'N/A'),
            cell(item.stats && item.stats.average !== undefined ? item.stats.average : 'N/A'),
            cell(item.stats && item.stats.totalVotes !== undefined ? item.stats.totalVotes : 0),
            cell(new Date(item.timestamp || Date.now()).toLocaleString())
        ]);

        const csv = '\ufeff' + [headers.map(cell).join(','), ...rows.map(r => r.join(','))].join('\r\n');

        // Blob URL (not a data: URI) so '#', '&' and non-ASCII characters survive intact.
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `Sprint_Planning_Poker_${Date.now()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
